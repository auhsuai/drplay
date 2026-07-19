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
const DEFAULT_BUFFER_SECONDS_USIZE: usize = 300;

pub mod protocol;
pub mod slice_cache;
pub mod r2;
mod thumbnail;

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

#[tauri::command]
async fn get_stream_url(file_id: String, bitrate: Option<f64>, buffer_seconds: Option<f64>, ext: Option<String>) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use std::time::{SystemTime, UNIX_EPOCH};

    let ext_str = ext.unwrap_or_default();
    let ext_param = if ext_str.is_empty() { String::new() } else { format!("&ext={}", ext_str) };

    let exp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() + STREAM_URL_TTL_SECS;
    let payload = format!("{}:{}:{}", file_id, ext_str, exp);
    let secret = crate::PROXY_SECRET.get().ok_or("Proxy not initialized")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(payload.as_bytes());
    let sig = mac.finalize().into_bytes().iter().map(|b| format!("{:02x}", b)).collect::<String>();

    if let Some(b) = bitrate {
        let buf = buffer_seconds.unwrap_or(DEFAULT_BUFFER_SECONDS_F64);
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

pub fn buffer_bytes_for_seconds(seconds: u64) -> u64 {
    let bytes = seconds * NOMINAL_BYTES_PER_SEC;
    bytes.clamp(MIN_BUFFER_BYTES, MAX_BUFFER_BYTES)
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
    cover_url: Option<String>,
    thumb_url: Option<String>,
    bitrate: i64,
    sample_rate: i64,
    bit_depth: i64,
    channels: i64,
    genre: String,
    year: i64,
    track_number: i64,
    album_artist: String,
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
    let has_cover_url = HAS_COVER_URL.get_or_init(|| {
        conn.prepare("SELECT cover_url FROM tracks LIMIT 1").is_ok()
    });
    let has_extended_meta = HAS_EXTENDED_META.get_or_init(|| {
        conn.prepare("SELECT bitrate FROM tracks LIMIT 1").is_ok()
    });

    // Column indices (when both file_type + cover_url present):
    // 0 title,1 artist,2 album,3 duration,4 file_path,
    // 5 has_cover(cover_art IS NOT NULL),6 file_type,7 id,
    // 8 cover_url,9 thumb_url,
    // 10 bitrate,11 sample_rate,12 bit_depth,13 channels,
    // 14 genre,15 year,16 track_number,17 album_artist.
    let query = match (*has_file_type, *has_cover_url, *has_extended_meta) {
        (true, true, true) => {
            "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type, id, cover_url, thumb_url, bitrate, sample_rate, bit_depth, channels, genre, year, track_number, album_artist FROM tracks WHERE size_bytes = ?"
        }
        (true, true, false) => {
            "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type, id, cover_url, thumb_url FROM tracks WHERE size_bytes = ?"
        }
        (true, false, _) => {
            "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type, id FROM tracks WHERE size_bytes = ?"
        }
        _ => {
            "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, '', id FROM tracks WHERE size_bytes = ?"
        }
    };

    let mut stmt = conn.prepare(query).ok()?;
    let mut rows = stmt.query([size]).ok()?;

    let mut first_match = None;
    while let Ok(Some(row)) = rows.next() {
        let file_path: String = row.get(4).unwrap_or_default();
        let (cover_url, thumb_url): (Option<String>, Option<String>) = if *has_cover_url {
            (row.get(8).unwrap_or_default(), row.get(9).unwrap_or_default())
        } else {
            (None, None)
        };
        let (bitrate, sample_rate, bit_depth, channels, genre, year, track_number, album_artist):
            (i64, i64, i64, i64, String, i64, i64, String) = if *has_extended_meta {
            (
                row.get(10).unwrap_or_default(),
                row.get(11).unwrap_or_default(),
                row.get(12).unwrap_or_default(),
                row.get(13).unwrap_or_default(),
                row.get(14).unwrap_or_default(),
                row.get(15).unwrap_or_default(),
                row.get(16).unwrap_or_default(),
                row.get(17).unwrap_or_default(),
            )
        } else {
            (0, 0, 0, 0, String::new(), 0, 0, String::new())
        };
        let meta = LocalMetadata {
            title: row.get(0).unwrap_or_default(),
            artist: row.get(1).unwrap_or_default(),
            album: row.get(2).unwrap_or_default(),
            duration: row.get(3).unwrap_or_default(),
            has_cover: row.get(5).unwrap_or_default() || cover_url.as_deref().map(|k| k.starts_with("covers/")).unwrap_or(false),
            file_type: row.get(6).unwrap_or_default(),
            id: row.get(7).unwrap_or_default(),
            cover_url,
            thumb_url,
            bitrate,
            sample_rate,
            bit_depth,
            channels,
            genre,
            year,
            track_number,
            album_artist,
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
    #[allow(unused_variables)]
    _app_handle: tauri::AppHandle,
) -> Option<LocalMetadata> {
    let conn = pool.get().ok()?;
    let meta = get_local_metadata_internal(size, &name, &conn)?;

    // `has_cover` is derived purely from the DB (cover_art IS NOT NULL OR a valid
    // R2 key in cover_url). Covers are no longer persisted to disk, and the
    // in-RAM moka cache (protocol.rs) only holds real R2/SQLite covers, so no
    // disk existence check is needed here — `has_cover` stays authoritative.

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
pub(crate) static GLOBAL_BUFFER_SECONDS: AtomicUsize = AtomicUsize::new(DEFAULT_BUFFER_SECONDS_USIZE);
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
async fn clear_local_cache(_app: tauri::AppHandle) -> Result<(), String> {
    // Covers are now served from the in-RAM `COVER_CACHE` (protocol.rs) with an R2
    // source of truth; nothing is persisted to disk anymore, so there is no on-disk
    // cover cache to clear. Kept as a stable, idempotent no-op command so the existing
    // JS caller keeps working without change.
    Ok(())
}

use std::sync::OnceLock;

pub static HAS_FILE_TYPE: OnceLock<bool> = OnceLock::new();
pub static HAS_THUMB: OnceLock<bool> = OnceLock::new();
pub static HAS_COVER_URL: OnceLock<bool> = OnceLock::new();
pub static HAS_EXTENDED_META: OnceLock<bool> = OnceLock::new();
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

            // Initialize the access recorder used by the cover GET path in protocol.rs.
            // The recorder MUST be set here: the protocol handler returns HTTP 500 if it
            // is missing. The log path is where recorded accesses are flushed.
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

                    // Migration: add R2 cover/thumb URL columns so old DBs still open.
                    // Mirrors how `file_type` was gated with HAS_FILE_TYPE.
                    let has_cover_url = *HAS_COVER_URL.get_or_init(|| {
                        conn.prepare("SELECT cover_url FROM tracks LIMIT 1").is_ok()
                    });
                    if !has_cover_url {
                        let _ = conn.execute(
                            "ALTER TABLE tracks ADD COLUMN cover_url TEXT",
                            [],
                        );
                        let _ = conn.execute(
                            "ALTER TABLE tracks ADD COLUMN thumb_url TEXT",
                            [],
                        );
                    }

                    // Migration: add pro-grade audio metadata columns so old DBs
                    // (scanned before this feature) still open and just report 0/empty.
                    let has_extended_meta = *HAS_EXTENDED_META.get_or_init(|| {
                        conn.prepare("SELECT bitrate FROM tracks LIMIT 1").is_ok()
                    });
                    if !has_extended_meta {
                        for col in [
                            "ALTER TABLE tracks ADD COLUMN bitrate INTEGER",
                            "ALTER TABLE tracks ADD COLUMN sample_rate INTEGER",
                            "ALTER TABLE tracks ADD COLUMN bit_depth INTEGER",
                            "ALTER TABLE tracks ADD COLUMN channels INTEGER",
                            "ALTER TABLE tracks ADD COLUMN genre TEXT",
                            "ALTER TABLE tracks ADD COLUMN year INTEGER",
                            "ALTER TABLE tracks ADD COLUMN track_number INTEGER",
                            "ALTER TABLE tracks ADD COLUMN album_artist TEXT",
                        ] {
                            let _ = conn.execute(col, []);
                        }
                    }
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
            verify_track_exists,
            update_track_duration_in_db,
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
                duration REAL, file_path TEXT, cover_art BLOB,
                file_type TEXT, size_bytes INTEGER, cover_url TEXT, thumb_url TEXT,
                bitrate INTEGER, sample_rate INTEGER, bit_depth INTEGER, channels INTEGER,
                genre TEXT, year INTEGER, track_number INTEGER, album_artist TEXT
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
