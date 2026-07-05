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
pub static GLOBAL_STREAM_TOKEN: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

mod protocol;

lazy_static::lazy_static! {
    pub static ref GLOBAL_TOKEN_NOTIFY: std::sync::Arc<tokio::sync::Notify> = std::sync::Arc::new(tokio::sync::Notify::new());
}

#[command]
async fn update_stream_token(token: String) -> Result<(), String> {
    if let Ok(mut t) = GLOBAL_STREAM_TOKEN.lock() {
        *t = token;
    }
    GLOBAL_TOKEN_NOTIFY.notify_waiters();
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
async fn get_stream_url(file_id: String, bitrate: Option<f64>, buffer_seconds: Option<f64>, ext: Option<String>) -> Result<String, String> {
    let ext_str = ext.unwrap_or_default();
    let ext_param = if ext_str.is_empty() { String::new() } else { format!("&ext={}", ext_str) };
    
    if let Some(b) = bitrate {
        let buf = buffer_seconds.unwrap_or(180.0);
        Ok(format!("http://drplay.localhost/stream?id={}&bitrate={}&buffer={}{}", file_id, b, buf, ext_param))
    } else {
        Ok(format!("http://drplay.localhost/stream?id={}{}", file_id, ext_param))
    }
}

#[tauri::command]
async fn extract_metadata_safe(file_id: String, token: String) -> Result<serde_json::Value, String> {
    use std::io::Cursor;
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::probe::Probe;
    use lofty::tag::Accessor;
    use base64::Engine;

    let mut final_token = token;
    if let Ok(global) = GLOBAL_STREAM_TOKEN.lock() {
        if !global.is_empty() {
            final_token = global.clone();
        }
    }

    let client = reqwest::Client::new();
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", file_id);
    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", final_token))
        .header("Range", "bytes=0-131072") // 128KB should cover ID3 and Xing headers
        .send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("API Error: {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let mut cursor = Cursor::new(bytes.to_vec());
    
    let probe = match Probe::new(&mut cursor).guess_file_type() {
        Ok(p) => p,
        Err(_) => return Err("Could not guess file format".to_string()),
    };

    match probe.read() {
        Ok(tagged_file) => {
            let mut title = None;
            let mut artist = None;
            let mut duration = None;
            let mut picture_data = None;
            let mut picture_format = None;

            let dur = tagged_file.properties().duration().as_secs_f64();
            if dur > 0.0 {
                duration = Some(dur);
            }
            
            if let Some(tag) = tagged_file.primary_tag() {
                title = tag.title().map(|s| s.into_owned());
                artist = tag.artist().map(|s| s.into_owned());
                
                if let Some(pic) = tag.pictures().first() {
                    picture_data = Some(base64::engine::general_purpose::STANDARD.encode(pic.data()));
                    picture_format = pic.mime_type().map(|m| m.to_string());
                }
            } else if let Some(tag) = tagged_file.first_tag() {
                title = tag.title().map(|s| s.into_owned());
                artist = tag.artist().map(|s| s.into_owned());
            }

            Ok(serde_json::json!({
                "title": title,
                "artist": artist,
                "duration": duration,
                "pictureData": picture_data,
                "pictureFormat": picture_format,
            }))
        },
        Err(e) => Err(format!("Parse error: {}", e))
    }
}

pub static CURRENT_FILE_SIZE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[derive(Clone, Debug, PartialEq)]
pub enum DownloadState {
    Idle,
    Downloading,
    Completed,
    Failed(String),
}






#[tauri::command]
fn update_buffer_settings(seconds: usize) {
    GLOBAL_BUFFER_SECONDS.store(seconds, Ordering::SeqCst);
}

#[derive(serde::Serialize)]
struct LocalMetadata {
    id: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
    has_cover: bool,
    file_type: String,
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

#[tauri::command]
fn get_local_metadata(size: i64, name: String) -> Option<LocalMetadata> {
    use rusqlite::{Connection, OpenFlags};
    let mut log = String::new();
    log.push_str(&format!("get_local_metadata called with size={}, name={}\n", size, name));
    
    let db_path = get_db_path();
    log.push_str(&format!("db_path: {:?}\n", db_path));
    
    if let Some(db_path) = db_path {
        match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(conn) => {
                let has_file_type = conn.prepare("SELECT file_type FROM tracks LIMIT 1").is_ok();
                log.push_str(&format!("has_file_type: {}\n", has_file_type));
                
                let query = if has_file_type {
                    "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type, id FROM tracks WHERE size_bytes = ?"
                } else {
                    "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, '', id FROM tracks WHERE size_bytes = ?"
                };
                
                match conn.prepare(query) {
                    Ok(mut stmt) => {
                        match stmt.query([size]) {
                            Ok(mut rows) => {
                                let mut first_match = None;
                                let mut row_count = 0;
                                
                                while let Ok(Some(row)) = rows.next() {
                                    row_count += 1;
                                    let file_path: String = row.get(4).unwrap_or_default();
                                    let meta = LocalMetadata {
                                        title: row.get(0).unwrap_or_default(),
                                        artist: row.get(1).unwrap_or_default(),
                                        album: row.get(2).unwrap_or_default(),
                                        duration: row.get(3).unwrap_or_default(),
                                        has_cover: row.get(5).unwrap_or(false),
                                        file_type: row.get(6).unwrap_or_default(),
                                        id: row.get(7).unwrap_or_default(),
                                    };
                                    
                                    if file_path.contains(&name) || meta.title.contains(&name) || name.contains(&meta.title) {
                                        log.push_str(&format!("Found perfect match: {}\n", meta.title));
                                        std::fs::write("metadata_debug.log", log).unwrap_or_default();
                                        return Some(meta); // Perfect match
                                    }
                                    
                                    if first_match.is_none() {
                                        log.push_str(&format!("Saved first match: {}\n", meta.title));
                                        first_match = Some(meta);
                                    }
                                }
                                log.push_str(&format!("Rows returned: {}\n", row_count));
                                
                                std::fs::write("metadata_debug.log", log).unwrap_or_default();
                                return first_match;
                            },
                            Err(e) => {
                                log.push_str(&format!("Query execution failed: {}\n", e));
                            }
                        }
                    },
                    Err(e) => {
                        log.push_str(&format!("Prepare failed: {}\n", e));
                    }
                }
            },
            Err(e) => {
                log.push_str(&format!("Failed to open DB: {}\n", e));
            }
        }
    }
    
    std::fs::write("metadata_debug.log", log).unwrap_or_default();
    None
}

use std::sync::atomic::{AtomicUsize, AtomicBool, Ordering, AtomicU16};
use std::sync::Mutex;
use lazy_static::lazy_static;

mod proxy;

lazy_static! {
    pub static ref PROXY_SECRET: Mutex<String> = Mutex::new(uuid::Uuid::new_v4().to_string());
}
pub static PROXY_PORT: AtomicU16 = AtomicU16::new(0);
static GLOBAL_BUFFER_SECONDS: AtomicUsize = AtomicUsize::new(2400);
static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static IS_QUITTING: AtomicBool = AtomicBool::new(false);



#[tauri::command]
async fn clear_stream_token() -> Result<(), String> {
    if let Ok(mut global) = crate::GLOBAL_STREAM_TOKEN.lock() {
        global.clear();
    }
    Ok(())
}

#[tauri::command]
fn update_minimize_to_tray(minimize: bool) {

    MINIMIZE_TO_TRAY.store(minimize, Ordering::SeqCst);
}

// Proxy server is now handled by proxy.rs using axum

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    proxy::start_proxy();
    protocol::register(tauri::Builder::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use r2d2_sqlite::SqliteConnectionManager;
            use r2d2::Pool;
            let db_path = get_db_path().unwrap_or_else(|| std::path::PathBuf::from("music_database.db"));
            let manager = SqliteConnectionManager::file(&db_path);
            if let Ok(pool) = Pool::new(manager) {
                app.manage(pool);
            }
            
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show DrPlay", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        IS_QUITTING.store(true, Ordering::SeqCst);
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
                if !IS_QUITTING.load(std::sync::atomic::Ordering::SeqCst) && MINIMIZE_TO_TRAY.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            login_google_native,
            refresh_google_token,
            extract_metadata_safe,
            get_stream_url,
            update_buffer_settings,
            get_local_metadata,
            update_stream_token, clear_stream_token,
            update_minimize_to_tray
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                IS_QUITTING.store(true, Ordering::SeqCst);
            }
            _ => {}
        });
}
