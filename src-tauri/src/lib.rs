use oauth2::basic::BasicClient;
use oauth2::reqwest::{async_http_client, http_client};
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    RedirectUrl, Scope, TokenResponse, TokenUrl, RefreshToken
};
use serde_json::Value;
use std::time::Instant;
use tauri::command;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use std::sync::LazyLock;

pub static GLOBAL_STREAM_TOKEN: LazyLock<tokio::sync::Mutex<String>> =
    LazyLock::new(|| tokio::sync::Mutex::new(String::new()));
pub static GLOBAL_TOKEN_NOTIFY: LazyLock<std::sync::Arc<tokio::sync::Notify>> =
    LazyLock::new(|| std::sync::Arc::new(tokio::sync::Notify::new()));

// --- Named constants for the stream URL / buffer sizing (no magic numbers) ---
// Signed-URL lifetime: 24h. Shared by `get_stream_url` and the `/stream`
// redirect in protocol.rs so the two signers stay in sync.
pub(crate) const STREAM_URL_TTL_SECS: u64 = 86_400;
// Fallback buffer seconds when the frontend omits `buffer_seconds`.
const DEFAULT_BUFFER_SECONDS_F64: f64 = 180.0;
// Nominal decode rate used to size the prefetch window: 320 kbit/s audio
// => 320_000/8 = 40_000 bytes/s.
const NOMINAL_BYTES_PER_SEC: u64 = 320_000 / 8;
const MIN_BUFFER_BYTES: u64 = 5 * 1024 * 1024;
const MAX_BUFFER_BYTES: u64 = 500 * 1024 * 1024;
// Default prefetch window (seconds) when the user has not changed the setting.
// MUST match the frontend's own default (usePlayer.ts `useState(1400)`) — the
// frontend pushes its resolved value via `update_buffer_settings` shortly
// after startup, but keeping this constant in sync too closes the brief
// window between process start and that first sync (e.g. a stream started
// before the frontend's effect has run).
const DEFAULT_BUFFER_SECONDS_USIZE: usize = 1400;

pub mod protocol;
pub mod slice_cache;

// NOTE: this app streams audio straight from Google Drive — there is no
// Cloudflare R2 integration and no cover-art pipeline (removed along with the
// `r2` and `thumbnail` modules; see protocol.rs). There IS a local read-only
// SQLite tag lookup (`get_local_metadata` below) used ONLY to show real
// title/artist tags for rows in the "My Drive" list — everywhere else in the
// UI (Home, Liked Songs, Playlists, the player bar) still shows the Drive
// filename, never a DB tag.

#[command]
async fn update_stream_token(token: String) -> Result<(), String> {
    *GLOBAL_STREAM_TOKEN.lock().await = token;
    GLOBAL_TOKEN_NOTIFY.notify_waiters();
    Ok(())
}

#[command]
async fn login_google_native() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        const CREDENTIALS_JSON: &str = include_str!("../../wa_credential.json");
        let creds: serde_json::Value = serde_json::from_str(CREDENTIALS_JSON).map_err(|e| format!("Invalid wa_credential.json: {}", e))?;
        let client_id = ClientId::new(creds["installed"]["client_id"].as_str().ok_or("Missing client_id in wa_credential.json")?.to_string());
        let client_secret = ClientSecret::new(creds["installed"]["client_secret"].as_str().ok_or("Missing client_secret in wa_credential.json")?.to_string());
        let auth_url = AuthUrl::new("https://accounts.google.com/o/oauth2/v2/auth".to_string()).map_err(|e| format!("invalid AuthUrl: {e:?}"))?;
        let token_url = TokenUrl::new("https://oauth2.googleapis.com/token".to_string()).map_err(|e| format!("invalid TokenUrl: {e:?}"))?;

        // 1. Dynamic Port Binding
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("Failed to start server: {}", e))?;
        let port = server.server_addr().to_ip().ok_or("server address has no IP")?.port();
        let redirect_uri = format!("http://127.0.0.1:{}", port);

        let client = BasicClient::new(
            client_id,
            Some(client_secret),
            auth_url,
            Some(token_url),
        )
            .set_redirect_uri(RedirectUrl::new(redirect_uri.clone()).map_err(|e| format!("invalid RedirectUrl: {e:?}"))?);

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
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).map_err(|e| format!("invalid Content-Type header: {e:?}"))?);
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
                        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).map_err(|e| format!("invalid Content-Type header: {e:?}"))?);
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

fn build_stream_url(file_id: &str, bitrate: Option<f64>, buffer_seconds: Option<f64>, ext: Option<&str>) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::time::{SystemTime, UNIX_EPOCH};

    let ext_str = ext.unwrap_or("");
    let ext_param = if ext_str.is_empty() { String::new() } else { format!("&ext={}", ext_str) };

    let exp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() + STREAM_URL_TTL_SECS;
    let payload = format!("{}:{}:{}", file_id, ext_str, exp);
    // PANIC: PROXY_SECRET is initialized at startup in run() before any command handler runs.
    // If it's somehow not set, this is a fatal programming error — panic is appropriate.
    let secret = crate::PROXY_SECRET.get().expect("PROXY_SECRET not initialized — run() must be called first");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key from PROXY_SECRET");
    mac.update(payload.as_bytes());
    let sig = mac.finalize().into_bytes().iter().map(|b| format!("{:02x}", b)).collect::<String>();

    if let Some(b) = bitrate {
        let buf = buffer_seconds.unwrap_or(DEFAULT_BUFFER_SECONDS_F64);
        format!("http://drplay.localhost/stream?id={}&bitrate={}&buffer={}{}&exp={}&sig={}", file_id, b, buf, ext_param, exp, sig)
    } else {
        format!("http://drplay.localhost/stream?id={}{}&exp={}&sig={}", file_id, ext_param, exp, sig)
    }
}

#[tauri::command]
async fn get_stream_url(file_id: String, bitrate: Option<f64>, buffer_seconds: Option<f64>, ext: Option<String>) -> Result<String, String> {
    let start = Instant::now();
    let result = build_stream_url(&file_id, bitrate, buffer_seconds, ext.as_deref());
    let dur = start.elapsed();
    diag_log("get_stream_url", dur);
    Ok(result)
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

pub fn buffer_bytes_for_seconds(seconds: u64) -> u64 {
    let bytes = seconds * NOMINAL_BYTES_PER_SEC;
    bytes.clamp(MIN_BUFFER_BYTES, MAX_BUFFER_BYTES)
}

#[tauri::command]
fn update_buffer_settings(seconds: usize) {
    GLOBAL_BUFFER_SECONDS.store(seconds, Ordering::SeqCst);
}

// --- Local (DB-only) tag lookup for the "My Drive" list ---------------------
// Read-only: never writes to the DB, never touches R2, never serves cover art.
// If `music_database.db` is missing or lacks the expected columns, every call
// below degrades gracefully to `None` and the frontend falls back to the
// Drive filename — this is optional enrichment, not a hard dependency.

#[derive(serde::Serialize, Clone)]
struct LocalMetadata {
    id: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
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

// Dedup by file size (Drive doesn't give us a stable local row id), then
// prefer whichever candidate's file_path/title actually matches the file name
// — mirrors how the frontend already identifies a track (size + name).
fn get_local_metadata_internal(
    size: i64,
    name: &str,
    conn: &rusqlite::Connection,
) -> Option<LocalMetadata> {
    let has_file_type = HAS_FILE_TYPE.get_or_init(|| {
        conn.prepare("SELECT file_type FROM tracks LIMIT 1").is_ok()
    });

    let query = if *has_file_type {
        "SELECT title, artist, album, duration, file_type, id, file_path FROM tracks WHERE size_bytes = ?"
    } else {
        "SELECT title, artist, album, duration, '', id, file_path FROM tracks WHERE size_bytes = ?"
    };

    let mut stmt = conn.prepare(query).ok()?;
    let mut rows = stmt.query([size]).ok()?;

    let mut first_match = None;
    while let Ok(Some(row)) = rows.next() {
        let file_path: String = row.get(6).unwrap_or_default();
        let meta = LocalMetadata {
            title: row.get(0).unwrap_or_default(),
            artist: row.get(1).unwrap_or_default(),
            album: row.get(2).unwrap_or_default(),
            duration: row.get(3).unwrap_or_default(),
            file_type: row.get(4).unwrap_or_default(),
            id: row.get(5).unwrap_or_default(),
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
) -> Option<LocalMetadata> {
    let start = Instant::now();
    let conn = pool.get().ok()?;
    let meta = get_local_metadata_internal(size, &name, &conn);
    diag_log("get_local_metadata", start.elapsed());
    meta
}

use std::sync::atomic::{AtomicUsize, AtomicBool, Ordering, AtomicU16, AtomicU64};
// Diagnostic: call counter for IPC timing
// Always log during profiling — removed the modulo-50 sampling.
fn diag_log(module: &str, dur: std::time::Duration) {
    static DIAG_COUNT: AtomicU64 = AtomicU64::new(0);
    let c = DIAG_COUNT.fetch_add(1, Ordering::Relaxed);
    eprintln!("[PERF] {} took {:?} (call #{})", module, dur, c);
}

mod proxy;

pub static PROXY_SECRET: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub static PROXY_PORT: AtomicU16 = AtomicU16::new(0);
pub(crate) static GLOBAL_BUFFER_SECONDS: AtomicUsize = AtomicUsize::new(DEFAULT_BUFFER_SECONDS_USIZE);
pub static GLOBAL_SLICE_CACHE: std::sync::OnceLock<slice_cache::SliceCache> =
    std::sync::OnceLock::new();
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
async fn clear_local_cache(_app: tauri::AppHandle) -> Result<(), String> {
    // No-op: this app no longer keeps any local metadata/cover cache on the
    // Rust side (the cover-art/R2/SQLite pipeline was removed). Kept as a
    // command so the frontend's "clear cache on root-folder switch" call
    // sites don't need to special-case its absence.
    Ok(())
}

pub static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
static HAS_FILE_TYPE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::PROXY_SECRET.get_or_init(|| uuid::Uuid::new_v4().to_string());
    {
        let seconds = GLOBAL_BUFFER_SECONDS.load(Ordering::Relaxed) as u64;
        let max_bytes = buffer_bytes_for_seconds(seconds);
        GLOBAL_SLICE_CACHE
            .set(slice_cache::SliceCache::new(max_bytes))
            .ok();
    }
    proxy::start_proxy();
    let app_result = protocol::register(tauri::Builder::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_keepawake::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).ok();

            // Best-effort, read-only SQLite pool for the local tag lookup
            // (`get_local_metadata`). If `music_database.db` doesn't exist,
            // `SqliteConnectionManager::file` will happily create an empty one
            // with no `tracks` table — `get_local_metadata_internal` already
            // degrades to `None` in that case, so this is never fatal.
            {
                use r2d2_sqlite::SqliteConnectionManager;
                use r2d2::Pool;
                let db_path = get_db_path().unwrap_or_else(|| std::path::PathBuf::from("music_database.db"));
                let manager = SqliteConnectionManager::file(&db_path);
                if let Ok(pool) = Pool::new(manager) {
                    app.manage(pool);
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
            update_minimize_to_tray,
            clear_local_cache,
        ])
        .build(tauri::generate_context!());

    let app = match app_result {
        Ok(app) => app,
        Err(e) => {
            eprintln!("[drplay] failed to build tauri application: {e}");
            std::process::exit(1);
        }
    };

    app.run(|_app_handle, event| match event {
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
                duration REAL, file_path TEXT,
                file_type TEXT, size_bytes INTEGER
            )",
            [],
        )
        .unwrap();
        conn
    }

    // Dedup by size: a track of the same byte size is matched, preferring a
    // name/title match, else the first row.
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
        assert_eq!(m.artist, "Artist A");
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

    #[test]
    fn no_match_returns_first_row_as_fallback() {
        let conn = setup();
        conn.execute(
            "INSERT INTO tracks (id, title, artist, duration, file_path, size_bytes) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params!["ONLY", "Unrelated Name", "Artist", 200.0, "/content/drive/v1/files/ONLY", 2000i64],
        )
        .unwrap();

        let m = get_local_metadata_internal(2000, "totally-different-name.mp3", &conn).unwrap();
        assert_eq!(m.id, "ONLY");
    }

    #[test]
    fn missing_size_returns_none() {
        let conn = setup();
        assert!(get_local_metadata_internal(999_999, "anything.mp3", &conn).is_none());
    }
}
