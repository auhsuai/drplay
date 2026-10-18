use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Real HTTP Range origin (stands in for Drive `files/{id}?alt=media`)
// ---------------------------------------------------------------------------

/// What one origin response served, so tests can prove the proxy streams ranges
/// instead of slurping whole files.
#[derive(Clone, Debug)]
pub(super) struct ServedRange {
    pub(super) path: String,
    pub(super) range: Option<String>,
    status: u16,
    declared_bytes: usize,
    content_range: Option<String>,
    pub(super) had_bearer: bool,
}

pub(super) struct Origin {
    pub(super) port: u16,
    served: Arc<Mutex<Vec<ServedRange>>>,
    pulled: Arc<std::sync::atomic::AtomicUsize>,
}

impl Origin {
    pub(super) fn requests(&self) -> Vec<ServedRange> {
        self.served.lock().expect("origin log must be lockable").clone()
    }

    /// Largest single range the CLIENT (mpv, via the proxy) asked for.
    pub(super) fn max_response_bytes(&self) -> usize {
        self.requests().iter().map(|entry| entry.declared_bytes).max().unwrap_or(0)
    }

    /// Bytes actually pulled OFF DISK and handed to the proxy. This is the
    /// measurement that answers "does the proxy buffer the whole file?": a
    /// buffering proxy would pull the file even when mpv stopped reading, a
    /// streaming one only pulls as far as the client consumes.
    pub(super) fn bytes_pulled(&self) -> usize {
        self.pulled.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Counts bytes handed to the proxy, then delegates. Backpressure (not a local
/// buffer) is what keeps this number small when the client stops reading.
struct CountingReader<R> {
    inner: R,
    counter: Arc<std::sync::atomic::AtomicUsize>,
}

impl<R: std::io::Read> std::io::Read for CountingReader<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(out)?;
        self.counter.fetch_add(count, std::sync::atomic::Ordering::SeqCst);
        Ok(count)
    }
}

/// Stall injected into the FIRST response: send a prefix, then go silent (the
/// connection stays open, no EOF) — a network dying mid-body.
#[derive(Clone, Copy)]
pub(super) struct Stall {
    pub(super) first_bytes: usize,
    pub(super) stall: Duration,
}

/// Read impl: hand out the prefix, sleep (silence, no EOF), then finish.
struct StallingReader {
    file: std::fs::File,
    remaining: usize,
    sent: usize,
    stall_after: usize,
    stall: Duration,
    stalled: bool,
}

impl std::io::Read for StallingReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        if self.sent >= self.stall_after && !self.stalled {
            self.stalled = true;
            std::thread::sleep(self.stall);
        }
        let wanted = out.len().min(self.remaining);
        let count = std::io::Read::read(&mut self.file, &mut out[..wanted])?;
        self.remaining -= count;
        self.sent += count;
        Ok(count)
    }
}

fn parse_range(header: Option<&str>, total: usize) -> (usize, usize) {
    let last = total.saturating_sub(1);
    let Some(header) = header else { return (0, last) };
    let raw = header.trim().strip_prefix("bytes=").unwrap_or(header);
    let mut parts = raw.splitn(2, '-');
    let start = parts.next().unwrap_or("0").trim().parse::<usize>().unwrap_or(0);
    let end = parts.next().unwrap_or("").trim().parse::<usize>().unwrap_or(last);
    (start.min(last), end.min(last))
}

/// Serve `path` with real `Range` support (the exact capability the proxy and
/// mpv depend on), recording every response. Ids in `missing_ids` answer 404.
pub(super) fn spawn_origin(path: &Path, stall: Option<Stall>, missing_ids: &[&str]) -> Origin {
    use std::io::{Read, Seek, SeekFrom};

    const WORKERS: usize = 8;
    let total = std::fs::metadata(path).expect("fixture metadata must be readable").len() as usize;
    let served: Arc<Mutex<Vec<ServedRange>>> = Arc::new(Mutex::new(Vec::new()));
    let pulled: Arc<std::sync::atomic::AtomicUsize> = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let path: Arc<PathBuf> = Arc::new(path.to_path_buf());
    let stall = Arc::new(Mutex::new(stall));
    let missing: Arc<Vec<String>> = Arc::new(missing_ids.iter().map(|id| (*id).to_string()).collect());
    let first_response = Arc::new(Mutex::new(true));

    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("range origin must bind"));
    let port = server.server_addr().to_ip().expect("origin address").port();
    for _ in 0..WORKERS {
        let server = Arc::clone(&server);
        let served = Arc::clone(&served);
        let pulled = Arc::clone(&pulled);
        let path = Arc::clone(&path);
        let stall = Arc::clone(&stall);
        let missing = Arc::clone(&missing);
        let first_response = Arc::clone(&first_response);
        std::thread::spawn(move || loop {
            let Ok(request) = server.recv() else { continue };
            let url = request.url().to_string();
            let mut record = ServedRange {
                path: url.clone(),
                range: None,
                status: 200,
                declared_bytes: 0,
                content_range: None,
                had_bearer: false,
            };
            for header in request.headers() {
                let name = header.field.as_str().as_str();
                if name.eq_ignore_ascii_case("range") {
                    record.range = Some(header.value.as_str().to_string());
                }
                if name.eq_ignore_ascii_case("authorization") {
                    record.had_bearer = header.value.as_str().starts_with("Bearer ");
                }
            }
            let requested_id = url
                .split("/drive/v3/files/")
                .nth(1)
                .map(|rest| rest.split(['?', '/']).next().unwrap_or("").to_string())
                .unwrap_or_default();
            let known = !missing.iter().any(|id| *id == requested_id);

            let is_first = {
                let mut guard = first_response.lock().expect("first-response flag");
                let was_first = *guard;
                *guard = false;
                was_first
            };
            let this_stall = if is_first { *stall.lock().expect("stall lock") } else { None };

            let response: tiny_http::Response<Box<dyn Read + Send>> = if !known {
                record.status = 404;
                tiny_http::Response::from_data(b"file not found".to_vec()).boxed()
            } else {
                let (start, end) = parse_range(record.range.as_deref(), total);
                let length = end - start + 1;
                record.status = 206;
                record.declared_bytes = length;
                record.content_range = Some(format!("bytes {start}-{end}/{total}"));
                let opened = std::fs::File::open(path.as_ref())
                    .and_then(|mut file| {
                        file.seek(SeekFrom::Start(start as u64))?;
                        Ok(file)
                    })
                    .expect("fixture must be openable");
                let reader: Box<dyn Read + Send> = match this_stall {
                    Some(stall) => Box::new(CountingReader {
                        inner: StallingReader {
                            file: opened,
                            remaining: length,
                            sent: 0,
                            stall_after: stall.first_bytes,
                            stall: stall.stall,
                            stalled: false,
                        },
                        counter: Arc::clone(&pulled),
                    }),
                    None => Box::new(CountingReader {
                        inner: opened.take(length as u64),
                        counter: Arc::clone(&pulled),
                    }),
                };
                let mut response = tiny_http::Response::from_data(Vec::new())
                    .with_status_code(206)
                    .with_data(reader, Some(length));
                for (name, value) in [
                    ("Content-Range", record.content_range.clone().unwrap_or_default()),
                    ("Accept-Ranges", "bytes".to_string()),
                ] {
                    response.add_header(
                        tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
                            .expect("header must be valid"),
                    );
                }
                response.boxed()
            };
            served.lock().expect("origin log lock").push(record);
            let _ = request.respond(response);
        });
    }
    Origin { port, served, pulled }
}
