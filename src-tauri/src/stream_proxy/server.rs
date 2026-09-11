//! Proxy engine: tiny_http accept loop + reqwest upstream fetch with manual
//! redirect following (Authorization re-applied per hop) and a blocking
//! reader that streams the upstream body through to the client.
//!
//! Threading model: tiny_http is a blocking server, so `spawn_proxy` starts
//! N plain worker threads that each pull requests via `Server::recv()`. The
//! async parts (upstream fetch, token refresh) run on the shared tokio
//! runtime through `Handle::block_on`, keeping reqwest's async client.

use std::io::{self, Read};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::Arc;
use std::time::Duration;

use tokio::runtime::Handle;

use super::TokenSource;

/// Notified once per synthesized terminal failure (502/504) with the fileId.
pub(crate) type ErrorSink = Arc<dyn Fn(String, u16) + Send + Sync>;

/// Redirect hops we are willing to follow manually before giving up (502).
const MAX_REDIRECTS: usize = 5;
/// Dedicated accept threads; must exceed the largest expected burst of
/// concurrent media requests so a slow client cannot starve others.
const PROXY_WORKER_THREADS: usize = 4;
/// Bounded channel between the async body feeder and the blocking reader:
/// provides backpressure so a fast upstream cannot buffer unboundedly when
/// the client (mpv) reads slowly.
const BODY_CHANNEL_CAPACITY: usize = 8;
/// Pause before retrying after a recv() failure, to avoid a hot error loop.
const RECV_RETRY_DELAY: Duration = Duration::from_millis(200);

struct ProxyContext {
    client: reqwest::Client,
    base_url: String,
    tokens: Arc<dyn TokenSource>,
    headers_timeout: Duration,
    sink: ErrorSink,
    runtime: Handle,
}

pub(crate) fn spawn_proxy(
    sink: ErrorSink,
    drive_base_url: String,
    tokens: Arc<dyn TokenSource>,
    upstream_headers_timeout: Duration,
    runtime: Handle,
) -> Result<u16, String> {
    let http_server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("stream proxy: failed to bind 127.0.0.1:0: {e}"))?;
    let port = http_server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "stream proxy: bound address has no IP".to_string())?
        .port();
    let http_server = Arc::new(http_server);
    // Redirects are followed by hand (see fetch_upstream): automatic following
    // strips the Authorization header on cross-origin hops.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("stream proxy: failed to build upstream HTTP client: {e}"))?;
    let context = Arc::new(ProxyContext {
        client,
        base_url: drive_base_url,
        tokens,
        headers_timeout: upstream_headers_timeout,
        sink,
        runtime,
    });
    for _ in 0..PROXY_WORKER_THREADS {
        let http_server = Arc::clone(&http_server);
        let context = Arc::clone(&context);
        std::thread::spawn(move || worker_loop(http_server, context));
    }
    log::info!("[stream-proxy] listening on 127.0.0.1:{port}");
    Ok(port)
}

fn worker_loop(http_server: Arc<tiny_http::Server>, context: Arc<ProxyContext>) {
    loop {
        match http_server.recv() {
            Ok(request) => handle_request(request, &context),
            Err(recv_error) => {
                log::error!("[stream-proxy] failed to receive request: {recv_error}");
                std::thread::sleep(RECV_RETRY_DELAY);
            }
        }
    }
}

fn handle_request(request: tiny_http::Request, context: &ProxyContext) {
    if *request.method() != tiny_http::Method::Get {
        let _ = request.respond(error_response(405, "only GET is supported"));
        return;
    }
    let Some(path_and_query) = request.url().strip_prefix("/stream/") else {
        let _ = request.respond(error_response(404, "unknown path; expected /stream/{fileId}"));
        return;
    };
    let file_id = path_and_query.split('?').next().unwrap_or_default().to_string();
    if !is_valid_file_id(&file_id) {
        let _ = request.respond(error_response(400, "invalid file id"));
        return;
    }
    let range = request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case("range"))
        .map(|header| header.value.as_str().to_string());

    match context.runtime.block_on(serve(context, &file_id, range)) {
        Ok(response) => {
            if let Err(respond_error) = request.respond(response) {
                log::warn!("[stream-proxy] client disconnected while streaming {file_id}: {respond_error}");
            }
        }
        Err((status, message)) => {
            log::warn!("[stream-proxy] file {file_id}: responding {status}: {message}");
            if matches!(status, 502 | 504) {
                (context.sink)(file_id.to_string(), status);
            }
            let _ = request.respond(error_response(status, &message));
        }
    }
}

async fn serve(
    context: &ProxyContext,
    file_id: &str,
    range: Option<String>,
) -> Result<tiny_http::Response<Box<dyn Read + Send>>, (u16, String)> {
    // Seed a token up front (single-flight when several workers start cold).
    let token: String = match context.tokens.current() {
        Some(token) => token,
        None => Arc::clone(&context.tokens)
            .refresh(false)
            .await
            .map_err(|e| (502u16, format!("failed to obtain access token: {e}")))?,
    };
    let url = build_upstream_url(&context.base_url, file_id)?;
    let mut upstream = fetch_upstream(context, url.clone(), Some(&token), range.as_deref()).await?;
    if upstream.status() == reqwest::StatusCode::UNAUTHORIZED {
        // Exactly one refresh, then one retry; a second 401 is terminal (502).
        let fresh = Arc::clone(&context.tokens)
            .refresh(true)
            .await
            .map_err(|e| (502u16, format!("token refresh failed after upstream 401: {e}")))?;
        upstream = fetch_upstream(context, url.clone(), Some(&fresh), range.as_deref()).await?;
        if upstream.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err((502, "upstream rejected the request again after a token refresh".to_string()));
        }
    }
    Ok(pass_through_response(context, upstream))
}

fn build_upstream_url(base_url: &str, file_id: &str) -> Result<url::Url, (u16, String)> {
    url::Url::parse(&format!("{base_url}/drive/v3/files/{file_id}?alt=media"))
        .map_err(|e| (400u16, format!("failed to build upstream URL: {e}")))
}

/// Drive file ids are `[A-Za-z0-9_-]+`; rejecting anything else keeps hostile
/// strings out of the upstream URL without needing percent-encoding.
fn is_valid_file_id(file_id: &str) -> bool {
    !file_id.is_empty()
        && file_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

async fn fetch_upstream(
    context: &ProxyContext,
    mut url: url::Url,
    token: Option<&str>,
    range: Option<&str>,
) -> Result<reqwest::Response, (u16, String)> {
    for _ in 0..MAX_REDIRECTS {
        let mut request = context.client.get(url.clone());
        if let Some(token) = token {
            // Re-applied on every hop: this is why redirects are manual.
            request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(range) = range {
            request = request.header(reqwest::header::RANGE, range);
        }
        let sent = match tokio::time::timeout(context.headers_timeout, request.send()).await {
            Err(_elapsed) => {
                return Err((504, format!("upstream did not respond within {:?}", context.headers_timeout)))
            }
            Ok(Err(send_error)) => return Err((502, format!("upstream request failed: {send_error}"))),
            Ok(Ok(sent)) => sent,
        };
        if sent.status().is_redirection() {
            let location = sent
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| (502u16, "upstream redirect without Location header".to_string()))?;
            url = url
                .join(location)
                .map_err(|e| (502u16, format!("upstream redirect has invalid Location: {e}")))?;
            continue;
        }
        return Ok(sent);
    }
    Err((502, format!("upstream exceeded {MAX_REDIRECTS} redirects")))
}

/// Mirror the upstream response to the client: status, media headers, and a
/// streaming body (unknown length → chunked; known → Content-Length).
fn pass_through_response(
    context: &ProxyContext,
    upstream: reqwest::Response,
) -> tiny_http::Response<Box<dyn Read + Send>> {
    let status = upstream.status().as_u16();
    let mut outgoing = tiny_http::Response::from_data(Vec::new()).with_status_code(status);
    for header_name in [
        reqwest::header::CONTENT_TYPE,
        reqwest::header::CONTENT_RANGE,
        reqwest::header::ACCEPT_RANGES,
        reqwest::header::ETAG,
        reqwest::header::LAST_MODIFIED,
    ] {
        if let Some(value) = upstream.headers().get(&header_name).and_then(|value| value.to_str().ok()) {
            if let Ok(header) = tiny_http::Header::from_bytes(header_name.as_str().as_bytes(), value.as_bytes()) {
                outgoing.add_header(header);
            }
        }
    }
    let content_length = upstream
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    let reader = spawn_body_reader(context.runtime.clone(), upstream);
    outgoing.with_data(Box::new(reader), content_length).boxed()
}

/// Bridge the async upstream body into a blocking `Read` for tiny_http via a
/// bounded channel fed by a runtime task.
fn spawn_body_reader(runtime: Handle, mut upstream: reqwest::Response) -> ChunkReader {
    let (sender, receiver) = sync_channel::<Result<Vec<u8>, String>>(BODY_CHANNEL_CAPACITY);
    runtime.spawn(async move {
        loop {
            match upstream.chunk().await {
                Ok(Some(chunk)) => {
                    if sender.send(Ok(chunk.to_vec())).is_err() {
                        break; // client went away; stop pulling from upstream
                    }
                }
                Ok(None) => break,
                Err(body_error) => {
                    let _ = sender.send(Err(format!("upstream body error: {body_error}")));
                    break;
                }
            }
        }
    });
    ChunkReader { receiver, buffer: Vec::new(), position: 0, failed: false }
}

struct ChunkReader {
    receiver: Receiver<Result<Vec<u8>, String>>,
    buffer: Vec<u8>,
    position: usize,
    failed: bool,
}

impl Read for ChunkReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.buffer.len() {
            self.buffer.clear();
            self.position = 0;
            if self.failed {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "upstream body already failed"));
            }
            match self.receiver.recv() {
                Ok(Ok(chunk)) => self.buffer = chunk,
                Ok(Err(body_error)) => {
                    self.failed = true;
                    log::error!("[stream-proxy] upstream body failed mid-stream: {body_error}");
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "upstream body failed"));
                }
                Err(_) => return Ok(0), // feeder dropped its sender → clean EOF
            }
        }
        let available = self.buffer.len() - self.position;
        let count = available.min(out.len());
        out[..count].copy_from_slice(&self.buffer[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }
}

fn error_response(status: u16, message: &str) -> tiny_http::Response<Box<dyn Read + Send>> {
    tiny_http::Response::from_string(message.to_string())
        .with_status_code(status)
        .boxed()
}

#[cfg(test)]
mod spike_tests {
    //! Manual spike against the real Google Drive API (mirrors the Task 1
    //! `mpv_real_pipeline_spike` pattern). Run with:
    //! `cargo test real_drive_range_spike -- --ignored --nocapture`
    //! Requires a signed-in refresh token in the OS credential vault; it uses
    //! the stored credential only — no secrets are hard-coded or printed.

    use super::*;
    use crate::stream_proxy::DriveTokenSource;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "spike against the real Google Drive API"]
    async fn real_drive_range_spike() {
        let tokens: Arc<dyn TokenSource> = Arc::new(DriveTokenSource::default());
        let access = Arc::clone(&tokens)
            .refresh(false)
            .await
            .expect("access token must be mintable (sign in via the app first)");
        println!("access token minted (length {})", access.len());

        // Pick one real audio file through the Drive listing API.
        let client = reqwest::Client::new();
        let list = client
            .get("https://www.googleapis.com/drive/v3/files")
            .query(&[
                ("pageSize", "5"),
                ("q", "mimeType contains 'audio/'"),
                ("fields", "files(id,name)"),
                ("orderBy", "modifiedTime desc"),
            ])
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {access}"))
            .send()
            .await
            .expect("files.list request must succeed");
        assert_eq!(list.status(), 200, "files.list failed");
        let listing: serde_json::Value = list.json().await.expect("files.list must return JSON");
        let files = listing["files"].as_array().cloned().unwrap_or_default();
        assert!(!files.is_empty(), "no audio files found in this Drive");
        let file_id = files[0]["id"].as_str().expect("file id must be a string").to_string();
        let file_name = files[0]["name"].as_str().unwrap_or("?").to_string();
        println!("spiking with file: {file_name} ({file_id})");

        // Raw upstream probe with redirects disabled: does Drive answer 200
        // directly or 302 to googleusercontent.com (the manual-follow case)?
        let no_follow = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("probe client must build");
        let direct = no_follow
            .get(format!("https://www.googleapis.com/drive/v3/files/{file_id}"))
            .query(&[("alt", "media")])
            .header(reqwest::header::RANGE, "bytes=0-1023")
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {access}"))
            .send()
            .await
            .expect("direct upstream probe must succeed");
        println!("direct upstream status (Policy::none): {}", direct.status());

        // Start the production proxy (real base URL, real token source).
        let sink: ErrorSink = Arc::new(|file_id: String, status: u16| {
            println!("[spike] stream-proxy-error {file_id} {status}");
        });
        let port = spawn_proxy(
            sink,
            "https://www.googleapis.com".to_string(),
            tokens,
            Duration::from_secs(15),
            Handle::current(),
        )
        .expect("proxy must start");

        // Range request through the proxy, exactly like mpv will issue.
        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/stream/{file_id}"))
            .header(reqwest::header::RANGE, "bytes=0-1023")
            .send()
            .await
            .expect("proxy request must succeed");
        let status = response.status().as_u16();
        let content_range = response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response.bytes().await.expect("body must stream");
        println!("proxy status: {status}");
        println!("proxy content-range: {:?}", content_range);
        println!("proxy body bytes: {}", body.len());

        assert_eq!(status, 206, "expected 206 Partial Content through the proxy");
        assert_eq!(body.len(), 1024, "expected exactly 1024 body bytes");
        assert!(
            content_range
                .as_deref()
                .map(|value| value.starts_with("bytes 0-1023/"))
                .unwrap_or(false),
            "Content-Range must cover bytes 0-1023"
        );
        println!("SPIKE OK: 206 + 1024 bytes + Content-Range through the localhost proxy");
    }
}
