use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, LazyLock, Mutex};

const CHUNK_SIZE: u64 = 4 * 1024 * 1024;
const MAX_RETRIES: u32 = 2;
const RETRY_DELAYS_MS: [u64; 2] = [500, 1000];

pub(crate) static BLOCKING_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("blocking client")
});

pub struct StreamingReader {
    inner: Arc<Mutex<StreamingReaderInner>>,
}

struct StreamingReaderInner {
    url: String,
    total_size: u64,
    pos: u64,
    buffer: Vec<u8>,
    buffer_start: u64,
    buffer_end: u64,
    token: Option<String>,
    prefetch_buffer: Option<Vec<u8>>,
    prefetch_start: u64,
    prefetch_end: u64,
}

impl StreamingReader {
    pub fn new(url: String, total_size: u64) -> Self {
        Self::new_inner(url, total_size, None)
    }

    pub fn new_with_token(url: String, total_size: u64, token: String) -> Self {
        Self::new_inner(url, total_size, Some(token))
    }

    fn new_inner(url: String, total_size: u64, token: Option<String>) -> Self {
        let inner = StreamingReaderInner {
            url, total_size, pos: 0,
            buffer: Vec::new(), buffer_start: 0, buffer_end: 0,
            token,
            prefetch_buffer: None,
            prefetch_start: 0,
            prefetch_end: 0,
        };
        Self { inner: Arc::new(Mutex::new(inner)) }
    }

    fn fetch_range_raw(url: &str, token: &Option<String>, start: u64, end: u64) -> io::Result<Vec<u8>> {
        let mut last_err = None;
        for attempt in 0..MAX_RETRIES {
            let range_header = format!("bytes={}-{}", start, end);
            let mut req = BLOCKING_CLIENT.get(url).header("Range", &range_header);
            if let Some(ref t) = token {
                req = req.bearer_auth(t.clone());
            }
            let resp_result = req.send();

            match resp_result {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if status == 200 || status == 206 {
                        match resp.bytes() {
                            Ok(bytes) => return Ok(bytes.to_vec()),
                            Err(e) => {
                                last_err = Some(io::Error::new(
                                    io::ErrorKind::Other,
                                    format!("[stream_reader] body error: byte_offset={} error={}", start, e),
                                ));
                            }
                        }
                    } else {
                        last_err = Some(io::Error::new(
                            io::ErrorKind::Other,
                            format!("[stream_reader] status {}: byte_offset={}", status, start),
                        ));
                    }
                }
                Err(e) => {
                    log::warn!("[stream_reader] attempt {} failed: start={} error={}", attempt + 1, start, e);
                    last_err = Some(io::Error::new(
                        io::ErrorKind::Other,
                        format!("[stream_reader] network error: start={} error={}", start, e),
                    ));
                }
            }

            if attempt < MAX_RETRIES - 1 {
                std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAYS_MS[attempt as usize]));
            }
        }

        Err(last_err.unwrap_or_else(|| {
            io::Error::new(io::ErrorKind::Other, format!("[stream_reader] exhausted retries: byte_offset={}", start))
        }))
    }

}

impl Read for StreamingReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut inner = self.inner.try_lock().map_err(|_| {
            io::Error::new(io::ErrorKind::Other, "[stream_reader] try_lock failed in read")
        })?;

        if inner.pos >= inner.total_size {
            return Ok(0);
        }

        // Swap prefetched buffer when current is exhausted
        if inner.pos >= inner.buffer_end {
            if let Some(pb) = inner.prefetch_buffer.take() {
                inner.buffer = pb;
                inner.buffer_start = inner.prefetch_start;
                inner.buffer_end = inner.prefetch_end;
            }
        }

        // Synchronous fetch if buffer still empty (no prefetch available)
        if inner.pos >= inner.buffer_end {
            let url = inner.url.clone();
            let token = inner.token.clone();
            let fetch_start = inner.pos;
            let fetch_end = (fetch_start + CHUNK_SIZE - 1).min(inner.total_size - 1);
            drop(inner);

            let fetched = Self::fetch_range_raw(&url, &token, fetch_start, fetch_end)?;
            let fetched_len = fetched.len() as u64;

            let mut guard = self.inner.try_lock().map_err(|_| {
                io::Error::new(io::ErrorKind::Other, "[stream_reader] try_lock failed in read")
            })?;
            guard.buffer = fetched;
            guard.buffer_start = fetch_start;
            guard.buffer_end = fetch_start + fetched_len;

            let buffer_offset = (guard.pos - guard.buffer_start) as usize;
            let available = guard.buffer.len() - buffer_offset;
            let to_copy = available.min(buf.len());

            buf[..to_copy].copy_from_slice(&guard.buffer[buffer_offset..buffer_offset + to_copy]);
            guard.pos += to_copy as u64;

            let remaining = guard.buffer_end.saturating_sub(guard.pos);
            if remaining < CHUNK_SIZE / 4 && guard.buffer_end < guard.total_size && guard.prefetch_buffer.is_none() {
                let next_start = guard.buffer_end;
                let next_end = (next_start + CHUNK_SIZE - 1).min(guard.total_size - 1);
                let my_url = guard.url.clone();
                let my_token = guard.token.clone();
                let inner_arc = self.inner.clone();
                drop(guard);

                std::thread::spawn(move || {
                    match Self::fetch_range_raw(&my_url, &my_token, next_start, next_end) {
                        Ok(data) => {
                            let data_len = data.len() as u64;
                            let mut g = inner_arc.lock().unwrap();
                            g.prefetch_buffer = Some(data);
                            g.prefetch_start = next_start;
                            g.prefetch_end = next_start + data_len;
                        }
                        Err(e) => {
                            log::warn!("[stream_reader] async prefetch failed: start={} error={}", next_start, e);
                        }
                    }
                });
            }

            return Ok(to_copy);
        }

        // Data available in buffer normally
        let buffer_offset = (inner.pos - inner.buffer_start) as usize;
        let available = inner.buffer.len() - buffer_offset;
        let to_copy = available.min(buf.len());

        buf[..to_copy].copy_from_slice(&inner.buffer[buffer_offset..buffer_offset + to_copy]);
        inner.pos += to_copy as u64;

        // Trigger async prefetch for next chunk when running low
        let remaining = inner.buffer_end.saturating_sub(inner.pos);
        if remaining < CHUNK_SIZE / 4 && inner.buffer_end < inner.total_size && inner.prefetch_buffer.is_none() {
            let next_start = inner.buffer_end;
            let next_end = (next_start + CHUNK_SIZE - 1).min(inner.total_size - 1);
            let my_url = inner.url.clone();
            let my_token = inner.token.clone();
            let inner_arc = self.inner.clone();
            drop(inner);

            std::thread::spawn(move || {
                match Self::fetch_range_raw(&my_url, &my_token, next_start, next_end) {
                    Ok(data) => {
                        let data_len = data.len() as u64;
                        let mut g = inner_arc.lock().unwrap();
                        g.prefetch_buffer = Some(data);
                        g.prefetch_start = next_start;
                        g.prefetch_end = next_start + data_len;
                    }
                    Err(e) => {
                        log::warn!("[stream_reader] async prefetch failed: start={} error={}", next_start, e);
                    }
                }
            });

            return Ok(to_copy);
        }

        Ok(to_copy)
    }
}

impl Seek for StreamingReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let mut inner = self.inner.try_lock().map_err(|_| {
            io::Error::new(io::ErrorKind::Other, "[stream_reader] try_lock failed in seek")
        })?;

        let new_pos = match pos {
            SeekFrom::Start(offset) => offset,
            SeekFrom::End(offset) => {
                if offset >= 0 {
                    inner.total_size
                } else {
                    inner.total_size.saturating_sub((-offset) as u64)
                }
            }
            SeekFrom::Current(offset) => {
                if offset >= 0 {
                    inner.pos.saturating_add(offset as u64)
                } else {
                    inner.pos.saturating_sub((-offset) as u64)
                }
            }
        };

        let new_pos = new_pos.min(inner.total_size);

        if new_pos >= inner.buffer_start && new_pos < inner.buffer_end {
            inner.pos = new_pos;
            return Ok(new_pos);
        }

        if new_pos >= inner.total_size {
            inner.pos = new_pos;
            return Ok(new_pos);
        }

        inner.prefetch_buffer = None;

        let url = inner.url.clone();
        let token = inner.token.clone();
        let total_size = inner.total_size;
        drop(inner);

        const SEEK_CHUNK_SIZE: u64 = CHUNK_SIZE;
        let end = (new_pos + SEEK_CHUNK_SIZE - 1).min(total_size - 1);
        let data = Self::fetch_range_raw(&url, &token, new_pos, end)?;

        let mut inner = self.inner.try_lock().map_err(|_| {
            io::Error::new(io::ErrorKind::Other, "[stream_reader] try_lock failed in seek after fetch")
        })?;
        inner.buffer = data;
        inner.buffer_start = new_pos;
        inner.buffer_end = new_pos + inner.buffer.len() as u64;
        inner.pos = new_pos;

        Ok(new_pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send<T: Send>() {}
    fn assert_sync<T: Sync>() {}

    #[test]
    fn test_streaming_reader_send_sync() {
        assert_send::<StreamingReader>();
        assert_sync::<StreamingReader>();
    }

    #[test]
    fn test_inner_seek_clamps_to_bounds() {
        let inner = StreamingReaderInner {
            url: "http://example.com/fake".into(),
            total_size: 1000,
            pos: 0,
            buffer: vec![0u8; 1000],
            buffer_start: 0,
            buffer_end: 1000,
            token: None,
            prefetch_buffer: None,
            prefetch_start: 0,
            prefetch_end: 0,
        };

        let mut reader = StreamingReader {
            inner: Arc::new(Mutex::new(inner)),
        };

        let pos = reader.seek(SeekFrom::Start(2000)).unwrap();
        assert_eq!(pos, 1000);

        reader.seek(SeekFrom::Start(0)).unwrap();

        let pos = reader.seek(SeekFrom::End(500)).unwrap();
        assert_eq!(pos, 1000);

        let pos = reader.seek(SeekFrom::End(-200)).unwrap();
        assert_eq!(pos, 800);

        let pos = reader.seek(SeekFrom::Current(-50)).unwrap();
        assert_eq!(pos, 750);

        let pos = reader.seek(SeekFrom::Current(1000)).unwrap();
        assert_eq!(pos, 1000);
    }
}
