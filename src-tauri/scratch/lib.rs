use oauth2::basic::BasicClient;
use oauth2::reqwest::async_http_client;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    RedirectUrl, Scope, TokenResponse, TokenUrl, RefreshToken
};
use serde_json::Value;
use tauri::command;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicUsize, AtomicBool, Ordering}};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use tauri::http::{Response, header};
use std::borrow::Cow;

static GLOBAL_STREAM_TOKEN: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static GLOBAL_BUFFER_SECONDS: AtomicUsize = AtomicUsize::new(2400);
static SESSION_ID: AtomicUsize = AtomicUsize::new(0);
static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static IS_QUITTING: AtomicBool = AtomicBool::new(false);

struct AppState {
    db_pool: Pool<SqliteConnectionManager>,
    http_client: reqwest::Client,
    track_cache: Arc<TrackCache>,
}

struct TrackCache {
    id: AsyncMutex<String>,
    base_pos: AsyncMutex<usize>,
    data: AsyncMutex<Vec<u8>>,
    content_length: AsyncMutex<Option<usize>>,
    content_type: AsyncMutex<String>,
    finished: AsyncMutex<bool>,
    capacity: AtomicUsize,
    notify: Notify,
}

impl TrackCache {
    fn new() -> Self {
        Self {
            id: AsyncMutex::new(String::new()),
            base_pos: AsyncMutex::new(0),
            data: AsyncMutex::new(Vec::with_capacity(10 * 1024 * 1024)),
            content_length: AsyncMutex::new(None),
            content_type: AsyncMutex::new(String::new()),
            finished: AsyncMutex::new(false),
            capacity: AtomicUsize::new(10 * 1024 * 1024),
            notify: Notify::new(),
        }
    }
}

fn get_db_path() -> Option<std::path::PathBuf> {
    if let Ok(mut exe_path) = std::env::current_exe() {
        exe_path.pop();
        let path1 = exe_path.join("music_databasev2.db");
        if path1.exists() { return Some(path1); }
        let path2 = exe_path.join("music_database.db");
        if path2.exists() { return Some(path2); }
    }

    if std::path::Path::new("music_databasev2.db").exists() {
        Some(std::path::PathBuf::from("music_databasev2.db"))
    } else if std::path::Path::new("../music_databasev2.db").exists() {
        Some(std::path::PathBuf::from("../music_databasev2.db"))
    } else if std::path::Path::new("music_database.db").exists() {
        Some(std::path::PathBuf::from("music_database.db"))
    } else if std::path::Path::new("../music_database.db").exists() {
        Some(std::path::PathBuf::from("../music_database.db"))
    } else {
        None
    }
}

#[command]
async fn update_stream_token(token: String) -> Result<(), String> {
    if let Ok(mut t) = GLOBAL_STREAM_TOKEN.lock() {
        *t = token;
    }
    Ok(())
}

#[command]
async fn update_minimize_to_tray(minimize: bool) {
    MINIMIZE_TO_TRAY.store(minimize, Ordering::SeqCst);
}

#[command]
async fn update_buffer_settings(seconds: usize, state: tauri::State<'_, AppState>) -> Result<(), String> {
    GLOBAL_BUFFER_SECONDS.store(seconds, Ordering::SeqCst);
    state.track_cache.notify.notify_waiters();
    Ok(())
}

#[command]
async fn get_proxy_cache_status(state: tauri::State<'_, AppState>) -> Result<(usize, usize, Option<usize>), String> {
    let base_pos = *state.track_cache.base_pos.lock().await;
    let data_len = state.track_cache.data.lock().await.len();
    let total_len = *state.track_cache.content_length.lock().await;
    Ok((base_pos, data_len, total_len))
}

#[command]
async fn get_stream_url(file_id: String, token: String, bitrate: Option<f64>, buffer_seconds: Option<f64>) -> Result<String, String> {
    if let Some(b) = bitrate {
        let buf = buffer_seconds.unwrap_or(180.0);
        Ok(format!("stream://localhost/stream.mp3?id={}&token={}&bitrate={}&buffer={}", file_id, token, b, buf))
    } else {
        Ok(format!("stream://localhost/stream.mp3?id={}&token={}", file_id, token))
    }
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

#[command]
async fn get_local_metadata(size: i64, name: String, state: tauri::State<'_, AppState>) -> Result<Option<LocalMetadata>, String> {
    let conn = state.db_pool.get().map_err(|e| e.to_string())?;
    
    // Run blocking sqlite queries in spawn_blocking
    let result = tauri::async_runtime::spawn_blocking(move || {
        let has_file_type = conn.prepare("SELECT file_type FROM tracks LIMIT 1").is_ok();
        let query = if has_file_type {
            "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type FROM tracks WHERE size_bytes = ?"
        } else {
            "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, '' FROM tracks WHERE size_bytes = ?"
        };
        
        let mut stmt = conn.prepare(query).ok()?;
        let mut rows = stmt.query([size]).ok()?;
        
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
                return Some(meta); // Perfect match
            }
            
            if first_match.is_none() {
                first_match = Some(meta);
            }
        }
        
        first_match
    }).await.map_err(|e| e.to_string())?;

    Ok(result)
}

#[command]
async fn get_cover_url(size: i64, thumb: bool, app_handle: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let cache_dir = app_handle.path().app_cache_dir().map_err(|e| e.to_string())?;
    let covers_dir = cache_dir.join("covers");
    
    // Ensure dir exists
    if !covers_dir.exists() {
        std::fs::create_dir_all(&covers_dir).map_err(|e| e.to_string())?;
    }
    
    let file_name = if thumb { format!("{}_thumb.jpg", size) } else { format!("{}.jpg", size) };
    let cover_path = covers_dir.join(&file_name);
    
    // Check if it already exists in cache
    if cover_path.exists() {
        return Ok(Some(cover_path.to_string_lossy().to_string()));
    }
    
    // If not, fetch from DB
    let pool = state.db_pool.clone();
    let path_clone = cover_path.clone();
    
    let found = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let has_thumb = conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok();
        
        let query = if thumb && has_thumb {
            "SELECT thumbnail, cover_art FROM tracks WHERE size_bytes = ? LIMIT 1"
        } else {
            "SELECT cover_art FROM tracks WHERE size_bytes = ? AND cover_art IS NOT NULL LIMIT 1"
        };
        
        let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([size]).map_err(|e| e.to_string())?;
        
        if let Ok(Some(row)) = rows.next() {
            let mut cover_art: Vec<u8> = Vec::new();
            if thumb && has_thumb {
                let t: Vec<u8> = row.get(0).unwrap_or_default();
                if !t.is_empty() {
                    cover_art = t;
                } else {
                    cover_art = row.get(1).unwrap_or_default();
                }
            } else {
                cover_art = row.get(0).unwrap_or_default();
            }
            
            if !cover_art.is_empty() {
                std::fs::write(&path_clone, cover_art).map_err(|e| e.to_string())?;
                return Ok(true);
            }
        }
        Ok(false)
    }).await.map_err(|e| e.to_string())??;
    
    if found {
        Ok(Some(cover_path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}


#[command]
async fn login_google_native() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
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

        open::that(auth_url.as_str()).map_err(|e| format!("Failed to open browser: {}", e))?;

        // This is a short-lived local server just for auth callback, blocking is fine here in a separate thread.
        // But since tiny_http is removed, we must use a basic TcpListener.
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:3456").map_err(|e| format!("Bind error: {}", e))?;
        
        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                let mut buffer = [0; 1024];
                stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer);
                
                let mut path = "";
                if let Some(line) = request.lines().next() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() > 1 {
                        path = parts[1];
                    }
                }
                
                let url = format!("http://localhost:3456{}", path);
                let parsed_url = url::Url::parse(&url).unwrap();

                let code = parsed_url.query_pairs().find(|(key, _)| key == "code");
                let state = parsed_url.query_pairs().find(|(key, _)| key == "state");

                if let (Some((_, code)), Some((_, state))) = (code, state) {
                    if state.into_owned() != *csrf_token.secret() {
                        let response = "HTTP/1.1 400 Bad Request\r\n\r\nCSRF Token Mismatch!";
                        let _ = stream.write_all(response.as_bytes());
                        return Err("CSRF Token Mismatch".to_string());
                    }

                    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\nĐăng nhập thành công! Bạn có thể đóng tab này và quay lại DrPlay.";
                    let _ = stream.write_all(response.as_bytes());

                    let token_result = client
                        .exchange_code(AuthorizationCode::new(code.into_owned()))
                        .set_pkce_verifier(pkce_verifier)
                        // Note: we can't use async_http_client here if inside blocking task, use reqwest::blocking?
                        // Actually, oauth2 crate allows using reqwest async, but we are inside spawn_blocking.
                        // We will use standard http_client from oauth2. Wait, oauth2 features? We didn't enable reqwest blocking.
                        // Let's return the code and exchange it outside spawn_blocking!
                        ;
                    
                    return Ok(serde_json::json!({
                        "code": code.into_owned(),
                        "pkce_verifier": pkce_verifier.secret().to_string()
                    }));
                }
            }
        }
        Err("Auth failed".to_string())
    }).await.map_err(|e| format!("Task panicked: {}", e))?
}

// ... more to come
