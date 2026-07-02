use oauth2::basic::BasicClient;
use oauth2::reqwest::{async_http_client, http_client};
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    RedirectUrl, Scope, TokenResponse, TokenUrl, RefreshToken
};
use serde_json::Value;
use tauri::command;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
static GLOBAL_STREAM_TOKEN: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[command]
async fn update_stream_token(token: String) -> Result<(), String> {
    if let Ok(mut t) = GLOBAL_STREAM_TOKEN.lock() {
        *t = token;
    }
    Ok(())
}

#[command]
async fn login_google_native() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // 1. Setup OAuth2 Client
        let client_id = ClientId::new("72581565914-qk5usrv31rmlfdn6lq03urm8fsto6do3.apps.googleusercontent.com".to_string());
        let client_secret = ClientSecret::new("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".to_string());
        let auth_url = AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).unwrap();
        let token_url = TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).unwrap();

        let client = BasicClient::new(
            client_id,
            Some(client_secret),
            auth_url,
            Some(token_url),
        )
        .set_redirect_uri(RedirectUrl::new("http://localhost:3456".to_string()).unwrap());

        // 2. Generate authorization URL
        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
        let (auth_url, csrf_token) = client
            .authorize_url(CsrfToken::new_random)
            .add_scope(Scope::new("https://www.googleapis.com/auth/drive".to_string()))
            .add_scope(Scope::new("email".to_string()))
            .add_scope(Scope::new("profile".to_string()))
            .add_extra_param("access_type", "offline")
            .add_extra_param("prompt", "consent")
            .set_pkce_challenge(pkce_challenge)
            .url();

        // 3. Open system browser
        open::that(auth_url.as_str()).map_err(|e| format!("Failed to open browser: {}", e))?;

        // 4. Start local server to wait for callback
        let server = tiny_http::Server::http("127.0.0.1:3456").map_err(|e| format!("Failed to start server: {}", e))?;

        for request in server.incoming_requests() {
            let url = format!("http://localhost:3456{}", request.url());
            let parsed_url = url::Url::parse(&url).unwrap();

            let code = parsed_url.query_pairs().find(|(key, _)| key == "code");
            let state = parsed_url.query_pairs().find(|(key, _)| key == "state");

            if let (Some((_, code)), Some((_, state))) = (code, state) {
                if state.into_owned() != *csrf_token.secret() {
                    let response = tiny_http::Response::from_string("CSRF Token Mismatch!");
                    let _ = request.respond(response);
                    return Err("CSRF Token Mismatch".to_string());
                }

                let response = tiny_http::Response::from_string(
                    "Đăng nhập thành công! Bạn có thể đóng tab này và quay lại DrPlay.",
                );
                let response = response.with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                let _ = request.respond(response);

                let token_result = client
                    .exchange_code(AuthorizationCode::new(code.into_owned()))
                    .set_pkce_verifier(pkce_verifier)
                    .request(http_client);

                match token_result {
                    Ok(token) => {
                        let access_token = token.access_token().secret().to_string();
                        let refresh_token = token.refresh_token().map(|t| t.secret().to_string());
                        return Ok(serde_json::json!({
                            "access_token": access_token,
                            "refresh_token": refresh_token
                        }));
                    }
                    Err(e) => {
                        return Err(format!("Failed to exchange token: {:?}", e));
                    }
                }
            } else {
                let response = tiny_http::Response::from_string("No code provided.");
                let _ = request.respond(response);
                return Err("Authorization failed: no code returned.".to_string());
            }
        }

        Err("Server stopped unexpectedly".to_string())
    }).await.map_err(|e| format!("Task panicked: {}", e))?
}

#[command]
async fn refresh_google_token(refresh_token: String) -> Result<Value, String> {
    let client_id = ClientId::new("72581565914-qk5usrv31rmlfdn6lq03urm8fsto6do3.apps.googleusercontent.com".to_string());
    let client_secret = ClientSecret::new("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".to_string());
    let token_url = TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).unwrap();

    let client = BasicClient::new(
        client_id,
        Some(client_secret),
        AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).unwrap(),
        Some(token_url),
    );

    let token_result = client
        .exchange_refresh_token(&RefreshToken::new(refresh_token))
        .request_async(async_http_client)
        .await
        .map_err(|e| format!("Failed to refresh token: {:?}", e))?;

    let access_token = token_result.access_token().secret().to_string();
    let new_refresh_token = token_result.refresh_token().map(|t| t.secret().to_string());

    Ok(serde_json::json!({
        "access_token": access_token,
        "refresh_token": new_refresh_token
    }))
}

#[tauri::command]
async fn get_stream_url(file_id: String, token: String, bitrate: Option<f64>, buffer_seconds: Option<f64>) -> Result<String, String> {
    if let Some(b) = bitrate {
        let buf = buffer_seconds.unwrap_or(180.0);
        Ok(format!("http://127.0.0.1:3457/stream.mp3?id={}&token={}&bitrate={}&buffer={}", file_id, token, b, buf))
    } else {
        Ok(format!("http://127.0.0.1:3457/stream.mp3?id={}&token={}", file_id, token))
    }
}

#[tauri::command]
fn get_proxy_cache_status() -> Result<(usize, usize, Option<usize>), String> {
    let cache = get_cache();
    let base_pos = *cache.base_pos.lock().unwrap();
    let data_len = cache.data.lock().unwrap().len();
    let total_len = *cache.content_length.lock().unwrap();
    Ok((base_pos, data_len, total_len))
}

#[tauri::command]
fn update_buffer_settings(seconds: usize) {
    GLOBAL_BUFFER_SECONDS.store(seconds, Ordering::SeqCst);
    let cache = get_cache();
    cache.condvar.notify_all(); // Wake up download thread if it's sleeping
}

#[derive(serde::Serialize)]
struct LocalMetadata {
    title: String,
    artist: String,
    album: String,
    duration: f64,
    has_cover: bool,
    file_type: String,
}

fn get_db_path() -> Option<&'static str> {
    if std::path::Path::new("music_databasev2.db").exists() {
        Some("music_databasev2.db")
    } else if std::path::Path::new("../music_databasev2.db").exists() {
        Some("../music_databasev2.db")
    } else if std::path::Path::new("music_database.db").exists() {
        Some("music_database.db")
    } else if std::path::Path::new("../music_database.db").exists() {
        Some("../music_database.db")
    } else {
        None
    }
}

#[tauri::command]
fn get_local_metadata(size: i64, name: String) -> Result<Option<LocalMetadata>, String> {
    use rusqlite::{Connection, OpenFlags};
    let db_path = match get_db_path() {
        Some(path) => path,
        None => return Ok(None)
    };
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
    
    let has_file_type = conn.prepare("SELECT file_type FROM tracks LIMIT 1").is_ok();
    let query = if has_file_type {
        "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type FROM tracks WHERE size_bytes = ?"
    } else {
        "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, '' FROM tracks WHERE size_bytes = ?"
    };
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([size]).map_err(|e| e.to_string())?;
    
    let mut first_match = None;
    
    while let Ok(Some(row)) = rows.next() {
        let file_path: String = row.get(4).unwrap_or_default();
        let meta = LocalMetadata {
            title: row.get(0).unwrap_or_default(),
            artist: row.get(1).unwrap_or_default(),
            album: row.get(2).unwrap_or_default(),
            duration: row.get(3).unwrap_or_default(),
            has_cover: row.get(5).unwrap_or(false),
            file_type: row.get(6).unwrap_or_default(),
        };
        
        if file_path.contains(&name) || meta.title.contains(&name) || name.contains(&meta.title) {
            return Ok(Some(meta)); // Perfect match
        }
        
        if first_match.is_none() {
            first_match = Some(meta);
        }
    }
    
    Ok(first_match)
}

use std::sync::{Arc, Mutex, Condvar, atomic::{AtomicUsize, Ordering}, OnceLock};
use std::thread;

static GLOBAL_CACHE: OnceLock<Arc<TrackCache>> = OnceLock::new();
static SESSION_ID: AtomicUsize = AtomicUsize::new(0);
static GLOBAL_BUFFER_SECONDS: AtomicUsize = AtomicUsize::new(2400);
static THUMBNAIL_CONCURRENCY: AtomicUsize = AtomicUsize::new(0);

struct ConcurrencyGuard;
impl ConcurrencyGuard {
    fn acquire() -> Self {
        while THUMBNAIL_CONCURRENCY.load(Ordering::SeqCst) >= 4 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        THUMBNAIL_CONCURRENCY.fetch_add(1, Ordering::SeqCst);
        Self
    }
}
impl Drop for ConcurrencyGuard {
    fn drop(&mut self) {
        THUMBNAIL_CONCURRENCY.fetch_sub(1, Ordering::SeqCst);
    }
}

fn get_cache() -> Arc<TrackCache> {
    GLOBAL_CACHE.get_or_init(|| Arc::new(TrackCache::new())).clone()
}

struct TrackCache {
    id: Mutex<String>,
    base_pos: Mutex<usize>,
    data: Mutex<Vec<u8>>,
    content_length: Mutex<Option<usize>>,
    content_type: Mutex<String>,
    finished: Mutex<bool>,
    capacity: Mutex<usize>,
    condvar: Condvar,
}

impl TrackCache {
    fn new() -> Self {
        Self {
            id: Mutex::new(String::new()),
            base_pos: Mutex::new(0),
            data: Mutex::new(Vec::with_capacity(10 * 1024 * 1024)),
            content_length: Mutex::new(None),
            content_type: Mutex::new(String::new()),
            finished: Mutex::new(false),
            capacity: Mutex::new(10 * 1024 * 1024),
            condvar: Condvar::new(),
        }
    }
}

struct CacheReader {
    expected_id: String,
    position: usize,
    cache: Arc<TrackCache>,
}

impl std::io::Read for CacheReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut data = self.cache.data.lock().unwrap();
        loop {
            let base_pos = *self.cache.base_pos.lock().unwrap();
            let current_id = self.cache.id.lock().unwrap().clone();
            
            // If the cache was overwritten by a different track, abort this reader!
            // Otherwise, we stream garbage data into the wrong response, causing massive memory leaks in WebView2
            if current_id != self.expected_id {
                return Ok(0);
            }
            
            // If the reader is somehow behind the base_pos, the cache jumped ahead.
            // We can't serve this request from cache anymore (return EOF to force browser to retry).
            if self.position < base_pos {
                return Ok(0);
            }
            
            let offset = self.position - base_pos;
            let available = data.len().saturating_sub(offset);
            
            if available > 0 {
                let to_copy = std::cmp::min(buf.len(), available);
                buf[..to_copy].copy_from_slice(&data[offset .. offset + to_copy]);
                self.position += to_copy;
                
                // Sliding Window Eviction: keep 20% of capacity behind the read pointer
                let mut base_pos_locked = self.cache.base_pos.lock().unwrap();
                let capacity = *self.cache.capacity.lock().unwrap();
                let current_offset = self.position.saturating_sub(*base_pos_locked);
                let keep_behind = std::cmp::max(1024 * 1024, capacity / 5); // At least 1MB, up to 20% of capacity
                
                if current_offset > keep_behind {
                    let drain_amount = current_offset - keep_behind;
                    if drain_amount > 1024 * 1024 { // Evict in chunks of at least 1MB
                        data.drain(0..drain_amount);
                        *base_pos_locked += drain_amount;
                        self.cache.condvar.notify_all(); // Wake up download thread if it's paused
                    }
                }
                
                return Ok(to_copy);
            } else {
                if *self.cache.finished.lock().unwrap() {
                    return Ok(0); // EOF
                }
                // Wait for more data
                data = self.cache.condvar.wait(data).unwrap();
            }
        }
    }
}

enum ProxyReader {
    Cache(CacheReader),
    Direct(reqwest::blocking::Response),
}

impl std::io::Read for ProxyReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            ProxyReader::Cache(r) => r.read(buf),
            ProxyReader::Direct(r) => r.read(buf),
        }
    }
}

pub fn spawn_proxy_server() {
    std::thread::spawn(|| {
        let server = tiny_http::Server::http("127.0.0.1:3457").unwrap();
        let http_client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        
        for request in server.incoming_requests() {
            let client = http_client.clone();
            std::thread::spawn(move || {
                let url = request.url().to_string();
                
                if url.starts_with("/cover") {
                    let full_url = format!("http://localhost{}", url);
                    let parsed_url = url::Url::parse(&full_url).unwrap();
                    let mut size_val: Option<i64> = None;
                    let mut thumb = false;
                    for (k, v) in parsed_url.query_pairs() {
                        if k == "size" { size_val = v.parse().ok(); }
                        if k == "thumb" { thumb = v == "true"; }
                    }
                    
                    if let Some(s) = size_val {
                        use rusqlite::{Connection, OpenFlags};
                        if let Some(db_path) = get_db_path() {
                            let mut thumb_served = false;
                            
                            // Try to serve cached thumbnail first
                            if thumb {
                                if let Some(parent) = std::path::Path::new(db_path).parent() {
                                    let thumb_dir = parent.join(".thumbnails");
                                    let thumb_path = thumb_dir.join(format!("{}.jpg", s));
                                    if thumb_path.exists() {
                                        if let Ok(cached_cover) = std::fs::read(&thumb_path) {
                                            let response = tiny_http::Response::from_data(cached_cover)
                                                .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"image/jpeg"[..]).unwrap())
                                                .with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap())
                                                .with_header(tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"public, max-age=31536000"[..]).unwrap());
                                            let _ = request.respond(response);
                                            return;
                                        }
                                    }
                                }
                            }
                            
                            if let Ok(conn) = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
                                let has_thumb = conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok();
                                
                                let query = if thumb && has_thumb {
                                    "SELECT thumbnail FROM tracks WHERE size_bytes = ? AND thumbnail IS NOT NULL LIMIT 1"
                                } else {
                                    "SELECT cover_art FROM tracks WHERE size_bytes = ? AND cover_art IS NOT NULL LIMIT 1"
                                };
                                
                                if let Ok(mut stmt) = conn.prepare(query) {
                                    if let Ok(mut rows) = stmt.query([s]) {
                                        if let Ok(Some(row)) = rows.next() {
                                            let cover_art: Vec<u8> = row.get(0).unwrap_or_default();
                                            if !cover_art.is_empty() {
                                                let response = tiny_http::Response::from_data(cover_art)
                                                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"image/jpeg"[..]).unwrap())
                                                    .with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap())
                                                    .with_header(tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"public, max-age=31536000"[..]).unwrap());
                                                let _ = request.respond(response);
                                                return;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    let response = tiny_http::Response::empty(404)
                        .with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                    let _ = request.respond(response);
                    return;
                }
                
                if url.starts_with("/stream") {
                    let full_url = format!("http://localhost{}", url);
                    let parsed_url = url::Url::parse(&full_url).unwrap();
                    let mut id = String::new();
                    let mut token = String::new();
                    let mut buffer_seconds: Option<f64> = None;
                    let mut bitrate: Option<f64> = None;
                    for (k, v) in parsed_url.query_pairs() {
                        if k == "id" { id = v.into_owned(); }
                        else if k == "token" { token = v.into_owned(); }
                        else if k == "buffer" { buffer_seconds = v.parse().ok(); }
                        else if k == "bitrate" { bitrate = v.parse().ok(); }
                    }
                    
                    let mut start_pos = 0;
                    let mut end_pos: Option<usize> = None;
                    let mut has_range = false;
                    for header in request.headers() {
                        if header.field.as_str().to_string().eq_ignore_ascii_case("range") {
                            has_range = true;
                            let val = header.value.as_str();
                            if val.starts_with("bytes=") {
                                let parts: Vec<&str> = val["bytes=".len()..].split('-').collect();
                                if let Ok(s) = parts[0].parse::<usize>() {
                                    start_pos = s;
                                }
                                if parts.len() > 1 && !parts[1].is_empty() {
                                    if let Ok(e) = parts[1].parse::<usize>() {
                                        end_pos = Some(e);
                                    }
                                }
                            }
                        }
                    }
                    
                    let cache = get_cache();
                    
                    let is_new = {
                        let mut current_id = cache.id.lock().unwrap();
                        let mut base_pos = cache.base_pos.lock().unwrap();
                        let data_len = cache.data.lock().unwrap().len();
                        
                        let mut needs_download = false;
                        if *current_id != id {
                            *current_id = id.clone();
                            needs_download = true;
                        } else if start_pos < *base_pos || start_pos > *base_pos + data_len + 5 * 1024 * 1024 {
                            // Jump outside the cached window (allow up to 5MB ahead without aborting)
                            needs_download = true;
                        }
                        
                        if needs_download {
                            cache.data.lock().unwrap().clear();
                            *base_pos = start_pos;
                            *cache.content_length.lock().unwrap() = None;
                            *cache.content_type.lock().unwrap() = String::new();
                            *cache.finished.lock().unwrap() = false;
                            true
                        } else {
                            false
                        }
                    };
                    
                    if is_new {
                        let session = SESSION_ID.fetch_add(1, Ordering::SeqCst) + 1;
                        let cache_clone = cache.clone();
                        let client_clone = client.clone();
                        let current_url_clone = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", id);
                        let mut final_token = token.clone();
                        if let Ok(global) = GLOBAL_STREAM_TOKEN.lock() {
                            if !global.is_empty() {
                                final_token = global.clone();
                            }
                        }
                        let token_clone = final_token;
                        let fetch_start_pos = start_pos; // The position we are fetching from
                        
                        thread::spawn(move || {
                            let mut req = client_clone.request(reqwest::Method::GET, &current_url_clone)
                                .header("Authorization", format!("Bearer {}", token_clone));
                                
                            if fetch_start_pos > 0 {
                                req = req.header("Range", format!("bytes={}-", fetch_start_pos));
                            }
                                
                            if let Ok(mut resp) = req.send() {
                                if !resp.status().is_success() {
                                    *cache_clone.finished.lock().unwrap() = true;
                                    cache_clone.condvar.notify_all();
                                    return;
                                }
                                // Extract total length from Content-Range if it's a 206
                                if let Some(cr) = resp.headers().get("content-range") {
                                    if let Ok(s) = cr.to_str() {
                                        if let Some(total_str) = s.split('/').last() {
                                            if let Ok(total) = total_str.parse::<usize>() {
                                                *cache_clone.content_length.lock().unwrap() = Some(total);
                                            }
                                        }
                                    }
                                } else if let Some(cl) = resp.content_length() {
                                    *cache_clone.content_length.lock().unwrap() = Some(cl as usize);
                                }
                                
                                if cache_clone.content_length.lock().unwrap().is_none() {
                                    *cache_clone.content_length.lock().unwrap() = Some(0); // Unblock main thread
                                }
                                
                                if let Some(ct) = resp.headers().get("content-type") {
                                    *cache_clone.content_type.lock().unwrap() = ct.to_str().unwrap_or("").to_string();
                                }
                                cache_clone.condvar.notify_all();
                                
                                let mut buf = vec![0u8; 65536];
                                loop {
                                    if SESSION_ID.load(Ordering::SeqCst) != session {
                                        break; // Abort, new track started
                                    }
                                    
                                    let mut is_aborted = false;
                                    {
                                        let mut data = cache_clone.data.lock().unwrap();
                                        loop {
                                            if SESSION_ID.load(Ordering::SeqCst) != session {
                                                is_aborted = true;
                                                break;
                                            }
                                            
                                            // Re-evaluate capacity inside the loop so we can respond to settings changes immediately!
                                            let buf_sec = GLOBAL_BUFFER_SECONDS.load(Ordering::SeqCst) as f64;
                                            let mut capacity = if let Some(b) = bitrate {
                                                ((b / 8.0) * buf_sec) as usize
                                            } else {
                                                100 * 1024 * 1024 // 100MB default max
                                            };
                                            capacity = std::cmp::min(capacity, 150 * 1024 * 1024); // Hard cap at 150MB to prevent memory leaks
                                            *cache_clone.capacity.lock().unwrap() = capacity;
                                            
                                            if data.len() < capacity {
                                                break;
                                            }
                                            
                                            let (new_data, _timeout) = cache_clone.condvar.wait_timeout(data, std::time::Duration::from_millis(500)).unwrap();
                                            data = new_data;
                                        }
                                    }
                                    if is_aborted {
                                        break;
                                    }
                                    
                                    match std::io::Read::read(&mut resp, &mut buf) {
                                        Ok(0) => {
                                            *cache_clone.finished.lock().unwrap() = true;
                                            cache_clone.condvar.notify_all();
                                            break;
                                        }
                                        Ok(n) => {
                                            // DOUBLE CHECK: Did a new seek happen while we were blocked waiting for this chunk?
                                            if SESSION_ID.load(Ordering::SeqCst) != session {
                                                break; // Abort without corrupting the newly cleared cache
                                            }
                                            cache_clone.data.lock().unwrap().extend_from_slice(&buf[..n]);
                                            cache_clone.condvar.notify_all();
                                        }
                                        Err(_) => {
                                            *cache_clone.finished.lock().unwrap() = true;
                                            cache_clone.condvar.notify_all();
                                            break;
                                        }
                                    }
                                }
                            } else {
                                *cache_clone.finished.lock().unwrap() = true;
                                cache_clone.condvar.notify_all();
                            }
                        });
                    }
                    
                    // Wait for headers to be available
                    let mut total_len = 0;
                    let mut ct = String::new();
                    {
                        let mut data = cache.data.lock().unwrap();
                        loop {
                            if *cache.finished.lock().unwrap() || cache.content_length.lock().unwrap().is_some() {
                                total_len = cache.content_length.lock().unwrap().unwrap_or(0);
                                ct = cache.content_type.lock().unwrap().clone();
                                break;
                            }
                            data = cache.condvar.wait(data).unwrap();
                        }
                    }
                    
                    let mut response_headers = Vec::new();
                    if !ct.is_empty() {
                        if let Ok(h) = tiny_http::Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()) {
                            response_headers.push(h);
                        }
                    }
                    
                    response_headers.push(tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap());
                    response_headers.push(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
                    response_headers.push(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Range"[..]).unwrap());
                    response_headers.push(tiny_http::Header::from_bytes(&b"Access-Control-Expose-Headers"[..], &b"Content-Length, Content-Range"[..]).unwrap());
                    
                    let mut response_len = if total_len > start_pos { Some(total_len - start_pos) } else if total_len == 0 { None } else { Some(0) };
                    let mut e_pos = if total_len > 0 { total_len - 1 } else { 0 };
                    
                    if has_range && total_len > 0 {
                        if let Some(e) = end_pos {
                            e_pos = std::cmp::min(e, total_len - 1);
                        } else {
                            // CRITICAL FIX: If browser requests bytes=0- (open-ended), FORCE a 2MB chunk!
                            // Otherwise Chromium will buffer the entire 3GB file into RAM over 5 minutes!
                            e_pos = std::cmp::min(start_pos + 2 * 1024 * 1024 - 1, total_len - 1);
                        }
                        
                        let chunk_len = e_pos - start_pos + 1;
                        response_len = Some(chunk_len);
                        
                        let cr = format!("bytes {}-{}/{}", start_pos, e_pos, total_len);
                        if let Ok(h) = tiny_http::Header::from_bytes(&b"Content-Range"[..], cr.as_bytes()) {
                            response_headers.push(h);
                        }
                    }
                    
                    let status = if has_range { 206 } else { 200 };
                    let reader = ProxyReader::Cache(CacheReader { expected_id: id.clone(), position: start_pos, cache: cache.clone() });
                    
                    let response = tiny_http::Response::new(
                        tiny_http::StatusCode(status),
                        response_headers,
                        reader,
                        response_len,
                        None
                    );
                    let _ = request.respond(response);
                } else {
                    let _ = request.respond(tiny_http::Response::empty(404));
                }
            });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    spawn_proxy_server();
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show DrPlay", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
                
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();
                api.prevent_close();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            login_google_native,
            refresh_google_token,
            get_stream_url,
            get_proxy_cache_status,
            update_buffer_settings,
            get_local_metadata,
            update_stream_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
