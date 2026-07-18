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
lazy_static::lazy_static! {
    pub static ref GLOBAL_STREAM_TOKEN: tokio::sync::Mutex<String> = tokio::sync::Mutex::new(String::new());
    pub static ref GLOBAL_TOKEN_NOTIFY: std::sync::Arc<tokio::sync::Notify> = std::sync::Arc::new(tokio::sync::Notify::new());
}

pub mod protocol;
pub mod slice_cache;
mod thumbnail;

#[command]
async fn update_stream_token(token: String) -> Result<(), String> {
    *GLOBAL_STREAM_TOKEN.lock().await = token;
    GLOBAL_TOKEN_NOTIFY.notify_waiters();
    Ok(())
}

#[command]
async fn get_memory_snapshot() -> Result<serde_json::Value, String> {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let pid = std::process::id();
    let working_set_kb: u64 = sys
        .process(sysinfo::Pid::from_u32(pid))
        .map(|p| p.memory()) // bytes on Windows
        .unwrap_or(0);

    let (entries, bytes, track_count) = if let Some(cache) = crate::GLOBAL_SLICE_CACHE.get() {
        cache.stats().await
    } else {
        (0, 0, 0)
    };

    Ok(serde_json::json!({
        "process_working_set_mb": working_set_kb / (1024 * 1024),
        "slice_cache_entries": entries,
        "slice_cache_bytes": bytes,
        "slice_cache_mb": bytes / (1024 * 1024),
        "slice_cache_track_count": track_count,
        "ts": chrono_now_secs(),
    }))
}

fn chrono_now_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[command]
async fn login_google_native() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        const CREDENTIALS_JSON: &str = include_str!("../../wa_credential.json");
        let creds: serde_json::Value = serde_json::from_str(CREDENTIALS_JSON).map_err(|e| format!("Invalid wa_credential.json: {}", e))?;
        let client_id = ClientId::new(creds["installed"]["client_id"].as_str().ok_or("Missing client_id in wa_credential.json")?.to_string());
        let client_secret = ClientSecret::new(creds["installed"]["client_secret"].as_str().ok_or("Missing client_secret in wa_credential.json")?.to_string());
        let auth_url = AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).unwrap();
        let token_url = TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).unwrap();

        // 1. Dynamic Port Binding
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("Failed to start server: {}", e))?;
        let port = server.server_addr().to_ip().unwrap().port();
        let redirect_uri = format!("http://127.0.0.1:{}", port);

        let client = BasicClient::new(
            client_id,
            Some(client_secret),
            auth_url,
            Some(token_url),
        )
        .set_redirect_uri(RedirectUrl::new(redirect_uri.clone()).unwrap());

        let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
        let (auth_url, csrf_token) = client
            .authorize_url(CsrfToken::new_random)
            .add_scope(Scope::new("https://www.googleapis.com/auth/drive".to_string()))
            .add_scope(Scope::new("https://www.googleapis.com/auth/drive.appdata".to_string()))
            .add_scope(Scope::new("email".to_string()))
            .add_scope(Scope::new("profile".to_string()))
            .add_extra_param("access_type", "offline")
            .add_extra_param("prompt", "consent")
            .set_pkce_challenge(pkce_challenge)
            .url();

        open::that(auth_url.as_str()).map_err(|e| format!("Failed to open browser: {}", e))?;

        // 2. Timeout (5 minutes)
        let timeout = std::time::Duration::from_secs(300);
        let start_time = std::time::Instant::now();

        while start_time.elapsed() < timeout {
            // Check for requests every 500ms
            if let Ok(Some(request)) = server.recv_timeout(std::time::Duration::from_millis(500)) {
                let url = format!("{}{}", redirect_uri, request.url());
                let parsed_url = url::Url::parse(&url).map_err(|e| format!("Invalid redirect URL: {}", e))?;

                let code = parsed_url.query_pairs().find(|(key, _)| key == "code");
                let state = parsed_url.query_pairs().find(|(key, _)| key == "state");
                let error = parsed_url.query_pairs().find(|(key, _)| key == "error");

                if error.is_some() {
                    let response = tiny_http::Response::from_string("<html><body><script>window.close();</script></body></html>")
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                    let _ = request.respond(response);
                    return Err("User cancelled authorization".to_string());
                }

                if let (Some((_, code)), Some((_, state))) = (code, state) {
                    if state.into_owned() != *csrf_token.secret() {
                        let response = tiny_http::Response::from_string("CSRF Token Mismatch!");
                        let _ = request.respond(response);
                        return Err("CSRF Token Mismatch".to_string());
                    }

                    // 3. Auto-close HTML Response
                    let html_response = r#"
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="utf-8">
                            <title>Đăng nhập thành công</title>
                            <style>
                                body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f8f9fa; color: #202124; }
                                .container { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                                h1 { font-size: 24px; margin-bottom: 12px; }
                                p { color: #5f6368; }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <h1>Đăng nhập thành công!</h1>
                                <p>Cửa sổ này sẽ tự động đóng lại trong giây lát.</p>
                                <p>Nếu không, bạn có thể tự đóng cửa sổ này.</p>
                            </div>
                            <script>
                                setTimeout(() => window.close(), 100);
                            </script>
                        </body>
                        </html>
                    "#;

                    let response = tiny_http::Response::from_string(html_response)
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
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
        }

        Err("Authorization timeout: user did not complete login within 5 minutes.".to_string())
    }).await.map_err(|e| format!("Task panicked: {}", e))?
}

#[command]
async fn refresh_google_token(refresh_token: String) -> Result<Value, String> {
    const CREDENTIALS_JSON: &str = include_str!("../../wa_credential.json");
    let creds: serde_json::Value = serde_json::from_str(CREDENTIALS_JSON).map_err(|e| format!("Invalid wa_credential.json: {}", e))?;
    let client_id = ClientId::new(creds["installed"]["client_id"].as_str().ok_or("Missing client_id in wa_credential.json")?.to_string());
    let client_secret = ClientSecret::new(creds["installed"]["client_secret"].as_str().ok_or("Missing client_secret in wa_credential.json")?.to_string());
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
    let expires_in = token_result.expires_in().map(|d| d.as_secs());

    Ok(serde_json::json!({
        "access_token": access_token,
        "refresh_token": new_refresh_token,
        "expires_in": expires_in
    }))
}

#[tauri::command]
async fn get_stream_url(file_id: String, bitrate: Option<f64>, buffer_seconds: Option<f64>, ext: Option<String>) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::time::{SystemTime, UNIX_EPOCH};

    let ext_str = ext.unwrap_or_default();
    let ext_param = if ext_str.is_empty() { String::new() } else { format!("&ext={}", ext_str) };

    let exp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() + 86400;
    let payload = format!("{}:{}:{}", file_id, ext_str, exp);
    let secret = crate::PROXY_SECRET.get().ok_or("Proxy not initialized")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(payload.as_bytes());
    let sig = mac.finalize().into_bytes().iter().map(|b| format!("{:02x}", b)).collect::<String>();

    if let Some(b) = bitrate {
        let buf = buffer_seconds.unwrap_or(180.0);
        Ok(format!("http://drplay.localhost/stream?id={}&bitrate={}&buffer={}{}&exp={}&sig={}", file_id, b, buf, ext_param, exp, sig))
    } else {
        Ok(format!("http://drplay.localhost/stream?id={}{}&exp={}&sig={}", file_id, ext_param, exp, sig))
    }
}

#[tauri::command]
fn register_download_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    scope
        .allow_directory(path, true)
        .map_err(|e| format!("failed to extend fs scope for download dir: {}", e))?;
    Ok(())
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

#[derive(serde::Serialize, Clone)]
struct LocalMetadata {
    id: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
    has_cover: bool,
    file_type: String,
}

pub(crate) fn get_db_path() -> Option<std::path::PathBuf> {
    if let Ok(mut exe_path) = std::env::current_exe() {
        exe_path.pop();
        let path = exe_path.join("music_database.db");
        if path.exists() { return Some(path); }
    }
    if std::path::Path::new("music_database.db").exists() {
        Some(std::path::PathBuf::from("music_database.db"))
    } else if std::path::Path::new("../music_database.db").exists() {
        Some(std::path::PathBuf::from("../music_database.db"))
    } else {
        None
    }
}

fn get_local_metadata_internal(
    size: i64,
    name: &str,
    conn: &rusqlite::Connection,
) -> Option<LocalMetadata> {
    let has_file_type = HAS_FILE_TYPE.get_or_init(|| {
        conn.prepare("SELECT file_type FROM tracks LIMIT 1").is_ok()
    });

    let query = if *has_file_type {
        "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type, id FROM tracks WHERE size_bytes = ?"
    } else {
        "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, '', id FROM tracks WHERE size_bytes = ?"
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
            has_cover: row.get(5).unwrap_or_default(),
            file_type: row.get(6).unwrap_or_default(),
            id: row.get(7).unwrap_or_default(),
        };

        if file_path.contains(name) || meta.title.contains(name) || name.contains(&meta.title) {
            return Some(meta);
        }

        if first_match.is_none() {
            first_match = Some(meta);
        }
    }

    first_match
}

#[tauri::command]
fn get_local_metadata(
    size: i64,
    name: String,
    pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>,
    app_handle: tauri::AppHandle,
) -> Option<LocalMetadata> {
    let conn = pool.get().ok()?;
    let mut meta = get_local_metadata_internal(size, &name, &conn)?;
    
    // Check if thumbnail exists on disk since we don't save to DB anymore
    use tauri::Manager;
    if !meta.has_cover {
        if let Ok(dir) = app_handle.path().app_cache_dir() {
            let thumb_path = crate::thumbnail::thumbnail_path(&dir, &meta.id, true);
            let full_path = crate::thumbnail::thumbnail_path(&dir, &meta.id, false);
            if thumb_path.exists() || full_path.exists() {
                meta.has_cover = true;
            }
        }
    }
    
    Some(meta)
}

#[tauri::command]
fn verify_track_exists(db_id: String, pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>) -> bool {
    let conn = match pool.get() {
        Ok(c) => c,
        Err(_) => return true,
    };
    conn.query_row("SELECT 1 FROM tracks WHERE id = ?", [&db_id], |_| Ok(()))
        .is_ok()
}

#[tauri::command]
async fn update_track_duration_in_db(
    db_id: String,
    duration: f64,
    pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tracks SET duration = ?1, duration_estimated = 0 WHERE id = ?2",
        rusqlite::params![duration, db_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

use std::sync::atomic::{AtomicUsize, AtomicBool, Ordering, AtomicU16};

mod proxy;

pub static PROXY_SECRET: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub static PROXY_PORT: AtomicU16 = AtomicU16::new(0);
pub(crate) static GLOBAL_BUFFER_SECONDS: AtomicUsize = AtomicUsize::new(2400);
pub static GLOBAL_SLICE_CACHE: once_cell::sync::OnceCell<slice_cache::SliceCache> =
    once_cell::sync::OnceCell::new();
static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static IS_QUITTING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
async fn clear_stream_token() -> Result<(), String> {
    crate::GLOBAL_STREAM_TOKEN.lock().await.clear();
    Ok(())
}

#[tauri::command]
fn update_minimize_to_tray(minimize: bool) {
    MINIMIZE_TO_TRAY.store(minimize, Ordering::SeqCst);
}

#[tauri::command]
async fn clear_local_cache(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        // Thumbnails live in `<app_cache_dir>/.thumbnails` (thumbnail.rs:67), and the
        // access log is co-located there so GC can map files to last-access times.
        let thumb_dir = cache_dir.join(".thumbnails");
        if !thumb_dir.exists() {
            // Idempotent: nothing to GC yet.
            return Ok(());
        }
        let access_log_path = thumb_dir.join("access_log.json");
        if let Err(e) = crate::thumbnail::gc_thumbnails(
            &thumb_dir,
            &access_log_path,
            &crate::thumbnail::GcPolicy::default(),
        ) {
            eprintln!("[clear_local_cache] failed to GC thumbnails: {}", e);
        }
    }
    Ok(())
}

use std::sync::OnceLock;

pub static HAS_FILE_TYPE: OnceLock<bool> = OnceLock::new();
pub static HAS_THUMB: OnceLock<bool> = OnceLock::new();
pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

fn configure_sqlite_durability(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::PROXY_SECRET.get_or_init(|| uuid::Uuid::new_v4().to_string());
    {
        let seconds = GLOBAL_BUFFER_SECONDS.load(Ordering::Relaxed) as u64;
        let bytes = seconds * 320_000 / 8;
        let max_bytes = bytes.clamp(5 * 1024 * 1024, 500 * 1024 * 1024);
        GLOBAL_SLICE_CACHE
            .set(slice_cache::SliceCache::new(max_bytes))
            .ok();
    }
    proxy::start_proxy();
    protocol::register(tauri::Builder::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_keepawake::init())
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).ok();

            // F2: point the access recorder at `<app_cache_dir>/.thumbnails/access_log.json`
            // so it is co-located with the thumbnail files (both under `app_cache_dir()/.thumbnails/`).
            // This is required for `gc_thumbnails` (driven by `clear_local_cache`) to map files
            // to last-access times; a mismatched path would make every thumbnail read as
            // `last_access = 0` and be wiped on the next GC.
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                let access_log = cache_dir.join(".thumbnails").join("access_log.json");
                crate::protocol::init_access_recorder(access_log);
            }

            use r2d2_sqlite::SqliteConnectionManager;
            use r2d2::Pool;
            let db_path = get_db_path().unwrap_or_else(|| std::path::PathBuf::from("music_database.db"));
            let manager = SqliteConnectionManager::file(&db_path);
            if let Ok(pool) = Pool::new(manager) {
                // Clone before manage so we can use for schema migration
                let migration_pool = pool.clone();
                app.manage(pool);

                // Schema migration
                if let Ok(conn) = migration_pool.get() {
                    configure_sqlite_durability(&conn).ok();
                }
            }

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show DrPlay", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let icon = app.default_window_icon().map(|i| i.clone());
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false);
            if let Some(icon) = icon {
                tray = tray.icon(icon);
            }
            let _tray = tray
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
            register_download_path,
            get_stream_url,
            update_buffer_settings,
            get_local_metadata,
            update_stream_token, clear_stream_token,
            get_memory_snapshot,
            update_minimize_to_tray,
            verify_track_exists,
            update_track_duration_in_db,
            clear_local_cache,
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE tracks (
                id TEXT, title TEXT, artist TEXT, album TEXT,
                duration REAL, file_path TEXT, cover_art BLOB,
                file_type TEXT, size_bytes INTEGER
            )",
            [],
        )
        .unwrap();
        conn
    }

    // Old size-based dedup: a track of the same byte size is matched,
    // preferring a name/title match, else the first row.
    #[test]
    fn dedup_by_size_prefers_name() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["AAA", "Song A", "Artist A", 200.0, "/content/drive/v1/files/AAA", 1000i64],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["BBB", "Song B", "Artist B", 200.0, "/content/drive/v1/files/BBB", 1000i64],
        )
        .unwrap();

        let m = get_local_metadata_internal(1000, "Song A", &conn).unwrap();
        assert_eq!(m.id, "AAA");
    }

    #[test]
    fn legacy_drive_path_still_reads() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["ZZZ", "My Song", "Someone", 200.0, "/content/drive/v1/files/ZZZ?alt=media", 1000i64],
        )
        .unwrap();

        let m = get_local_metadata_internal(1000, "My Song", &conn).unwrap();
        assert_eq!(m.id, "ZZZ");
    }
}
