use std::collections::{BTreeMap, HashSet};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::Duration;

pub(crate) const CHUNK_SIZE: u64 = 512 * 1024;
const MAX_RETRIES: u32 = 4;
const RETRY_DELAYS_MS: [u64; 4] = [500, 1000, 2000, 4000];

pub(crate) static BLOCKING_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("blocking client")
});

pub struct InnerState {
    pub url: String,
    pub token: Option<String>,
    pub total_size: u64,
    pub pos: u64,
    pub cache: BTreeMap<u64, Vec<u8>>,
    pub fetching: HashSet<u64>,
}

pub struct StreamingReader {
    pub inner: Arc<Mutex<InnerState>>,
    pub cond: Arc<Condvar>,
    gen: Arc<AtomicU64>,
    pub max_prefetch: u64,
    pub last_read_gen: Arc<AtomicU64>,
}

impl StreamingReader {
    pub fn new(url: String, total_size: u64, max_prefetch: u64) -> Self {
        Self::with_token(url, total_size, None, max_prefetch)
    }

    pub fn new_with_token(url: String, total_size: u64, token: String, max_prefetch: u64) -> Self {
        Self::with_token(url, total_size, Some(token), max_prefetch)
    }

    fn with_token(url: String, total_size: u64, token: Option<String>, max_prefetch: u64) -> Self {
        let inner = Arc::new(Mutex::new(InnerState {
            url,
            token,
            total_size,
            pos: 0,
            cache: BTreeMap::new(),
            fetching: HashSet::new(),
        }));
        let gen = Arc::new(AtomicU64::new(1));
        let cond = Arc::new(Condvar::new());
        let last_read_gen = Arc::new(AtomicU64::new(0));
        Self::start_prefetch(inner.clone(), gen.clone(), cond.clone(), 1, max_prefetch);
        Self { inner, cond, gen, max_prefetch, last_read_gen }
    }

    fn start_prefetch(inner: Arc<Mutex<InnerState>>, gen: Arc<AtomicU64>, cond: Arc<Condvar>, my_gen: u64, max_prefetch: u64) {
        std::thread::Builder::new()
            .name("drplay-prefetch".into())
            .spawn(move || {
                loop {
                    let chunk_info = {
                        let mut s = inner.lock().unwrap();
                        loop {
                            if gen.load(Ordering::SeqCst) != my_gen {
                                return;
                            }
                            let start = s.pos - (s.pos % CHUNK_SIZE);
                            let end = (start + max_prefetch).min(s.total_size.saturating_sub(1));
                            
                            if start >= end {
                                s = cond.wait(s).unwrap();
                                continue;
                            }
                            
                            let mut c = start;
                            let mut target_chunk = None;
                            while c <= end {
                                let chunk_end = (c + CHUNK_SIZE - 1).min(s.total_size.saturating_sub(1));
                                if chunk_end < c { break; }
                                if !s.cache.contains_key(&c) && !s.fetching.contains(&c) {
                                    target_chunk = Some((c, chunk_end));
                                    break;
                                }
                                c += CHUNK_SIZE;
                            }
                            
                            if let Some((c, chunk_end)) = target_chunk {
                                s.fetching.insert(c);
                                break Some((c, chunk_end, s.url.clone(), s.token.clone()));
                            } else {
                                s = cond.wait(s).unwrap();
                            }
                        }
                    };
                    
                    if let Some((c, chunk_end, url, token)) = chunk_info {
                        log::info!("[stream_reader] prefetch bytes {}-{}", c, chunk_end);
                        match fetch_range_raw(&url, &token, c, chunk_end) {
                            Ok(data) => {
                                if gen.load(Ordering::SeqCst) != my_gen { return; }
                                let mut s = inner.lock().unwrap();
                                s.cache.insert(c, data);
                                s.fetching.remove(&c);
                                cond.notify_all();
                            }
                            Err(e) => {
                                log::warn!("[stream_reader] prefetch error at {}: {}", c, e);
                                let mut s = inner.lock().unwrap();
                                s.fetching.remove(&c);
                                cond.notify_all();
                                drop(s);
                                std::thread::sleep(Duration::from_secs(1));
                            }
                        }
                    }
                }
            })
            .expect("failed to spawn prefetch thread");
    }

    pub fn stop_and_seek(&self, new_pos: u64) -> u64 {
        let new_gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
        
        let mut s = self.inner.lock().unwrap();
        let new_pos = new_pos.min(s.total_size);
        let aligned = new_pos - (new_pos % CHUNK_SIZE);
        s.cache.retain(|&k, _| k >= aligned);
        s.fetching.clear();
        s.pos = new_pos;
        drop(s);

        Self::start_prefetch(self.inner.clone(), self.gen.clone(), self.cond.clone(), new_gen, self.max_prefetch);
        
        new_pos
    }
}

impl Read for StreamingReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut s = self.inner.lock().unwrap();
        if s.total_size > 0 && s.pos >= s.total_size {
            return Ok(0);
        }
        let pos = s.pos;
        let chunk_start = pos - (pos % CHUNK_SIZE);

        while !s.cache.contains_key(&chunk_start) {
            if !s.fetching.contains(&chunk_start) {
                s.fetching.insert(chunk_start);
                
                let end = (chunk_start + CHUNK_SIZE - 1).min(s.total_size.saturating_sub(1));
                let url = s.url.clone();
                let token = s.token.clone();
                
                drop(s);
                log::info!("[stream_reader] sync-fetch bytes {}-{}", chunk_start, end);
                
                let data_res = fetch_range_raw(&url, &token, chunk_start, end);
                
                s = self.inner.lock().unwrap();
                match data_res {
                    Ok(data) => {
                        s.cache.insert(chunk_start, data);
                        s.fetching.remove(&chunk_start);
                        self.cond.notify_all();
                    }
                    Err(e) => {
                        log::error!("[stream_reader] sync-fetch failed: {}", e);
                        s.fetching.remove(&chunk_start);
                        self.cond.notify_all();
                        return Err(e);
                    }
                }
            } else {
                s = self.cond.wait(s).unwrap();
            }
        }

        let (to_copy, should_remove) = {
            let data = s.cache.get(&chunk_start).unwrap();
            let offset = (s.pos - chunk_start) as usize;
            if offset >= data.len() {
                return Ok(0);
            }
            let available = data.len() - offset;
            let to_copy = available.min(buf.len());
            buf[..to_copy].copy_from_slice(&data[offset..offset + to_copy]);
            let should_remove = offset + to_copy >= data.len();
            (to_copy, should_remove)
        };
        s.pos += to_copy as u64;

        if should_remove {
            s.cache.remove(&chunk_start);
            self.cond.notify_all();
        }
        self.last_read_gen.fetch_add(1, Ordering::Relaxed);
        Ok(to_copy)
    }
}

impl Seek for StreamingReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let new_pos = {
            let s = self.inner.lock().unwrap();
            match pos {
                SeekFrom::Start(offset) => offset.min(s.total_size),
                SeekFrom::End(offset) => {
                    if offset >= 0 { s.total_size }
                    else { s.total_size.saturating_sub((-offset) as u64) }
                }
                SeekFrom::Current(offset) => {
                    if offset >= 0 { s.pos.saturating_add(offset as u64).min(s.total_size) }
                    else { s.pos.saturating_sub((-offset) as u64) }
                }
            }
        };
        Ok(self.stop_and_seek(new_pos))
    }
}

impl Drop for StreamingReader {
    fn drop(&mut self) {
        self.gen.fetch_add(1, Ordering::SeqCst);
        self.cond.notify_all();
    }
}

pub(crate) fn fetch_range_raw(url: &str, token: &Option<String>, start: u64, end: u64) -> io::Result<Vec<u8>> {
    let range = format!("bytes={}-{}", start, end);
    for attempt in 0..MAX_RETRIES {
        let mut req = BLOCKING_CLIENT.get(url).header("Range", &range);
        if let Some(ref t) = token {
            req = req.bearer_auth(t.clone());
        }
        match req.send() {
            Ok(resp) => {
                let status = resp.status();
                if status == reqwest::StatusCode::PARTIAL_CONTENT || status == reqwest::StatusCode::OK {
                    return resp.bytes()
                        .map(|b| b.to_vec())
                        .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("body: start={} error={}", start, e)));
                }
                return Err(io::Error::new(io::ErrorKind::Other, format!("status {} start={}", status, start)));
            }
            Err(e) => {
                if attempt < MAX_RETRIES - 1 {
                    log::warn!("[stream_reader] retry {} start={} error={}", attempt + 1, start, e);
                    std::thread::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt as usize]));
                } else {
                    return Err(io::Error::new(io::ErrorKind::Other, format!("network: start={} error={}", start, e)));
                }
            }
        }
    }
    Err(io::Error::new(io::ErrorKind::Other, format!("exhausted retries start={}", start)))
}

pub struct SharedReader(pub Arc<Mutex<StreamingReader>>);

impl Read for SharedReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.lock().unwrap().read(buf)
    }
}

impl Seek for SharedReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.0.lock().unwrap().seek(pos)
    }
}
