use tauri::http::{Response, StatusCode};
use moka::future::Cache;
use bytes::Bytes;
use hmac::Mac;
use once_cell::sync::Lazy;

use std::path::Path;
use r2d2_sqlite::SqliteConnectionManager;

use crate::thumbnail::{validate_file_id, thumbnail_path};

const MAX_COVER_SIZE: usize = 52_428_800;

// Initialized from `lib.rs` `setup` with `<app_cache_dir>/.thumbnails/access_log.json`
// so that the access log is co-located with the thumbnail files (both under
// `app_cache_dir()/.thumbnails/`). This is required for `gc_thumbnails` to map files
// to their last-access times; if the log lived elsewhere every thumbnail would read as
// `last_access = 0` and be wiped on the next GC.
static ACCESS_RECORDER: std::sync::OnceLock<std::sync::Mutex<crate::thumbnail::AccessRecorder>> =
    std::sync::OnceLock::new();

pub fn init_access_recorder(log_path: std::path::PathBuf) {
    let recorder = crate::thumbnail::AccessRecorder::new(log_path);
    if ACCESS_RECORDER.set(std::sync::Mutex::new(recorder)).is_err() {
        eprintln!("[protocol] ACCESS_RECORDER already initialized");
    }
}

pub static ETAG_CACHE: Lazy<Cache<String, (String, Bytes)>> = Lazy::new(|| {
    Cache::builder()
        .max_capacity(50 * 1024 * 1024)
        .weigher(|_k, v: &(String, Bytes)| v.1.len() as u32)
        .build()
});

fn query_cover_blob(
    pool: &r2d2::Pool<SqliteConnectionManager>,
    file_id: &str,
    thumb: bool,
) -> Result<Option<Vec<u8>>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let has_thumb = *crate::HAS_THUMB.get_or_init(|| {
        conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok()
    });
    let sql = if thumb && has_thumb {
        "SELECT thumbnail, cover_art FROM tracks WHERE id = ? LIMIT 1"
    } else {
        "SELECT cover_art FROM tracks WHERE id = ? AND cover_art IS NOT NULL LIMIT 1"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([&file_id]).map_err(|e| e.to_string())?;
    if let Ok(Some(row)) = rows.next() {
        let cover: Vec<u8> = if thumb && has_thumb {
            let t: Vec<u8> = row.get(0).unwrap_or_default();
            if !t.is_empty() { t } else { row.get(1).unwrap_or_default() }
        } else {
            row.get(0).unwrap_or_default()
        };
        if !cover.is_empty() {
            return Ok(Some(cover));
        }
    }
    Ok(None)
}

fn handle_cover_get<R: tauri::Runtime>(
    raw_id: &str,
    thumb: bool,
    cache_dir: Option<&Path>,
    pool: Option<&r2d2::Pool<SqliteConnectionManager>>,
    recorder: &std::sync::Mutex<crate::thumbnail::AccessRecorder>,
    app: Option<&tauri::AppHandle<R>>,
) -> Result<(String, Bytes), String> {
    if let Err(e) = validate_file_id(raw_id) {
        return Err(e);
    }

    // Step 1: try filesystem (primary) exact match
    if let Some(dir) = cache_dir {
        let exact = thumbnail_path(dir, raw_id, thumb);
        if exact.exists() {
            if let Ok(data) = std::fs::read(&exact) {
                if let Ok(mut r) = recorder.lock() {
                    r.record(raw_id);
                }
                let etag = format!("\"{:x}\"", md5::compute(&data));
                return Ok((etag, Bytes::from(data)));
            }
        }
    }

    // Step 2: SQLite blob fallback — only for ids without drive_ prefix (legacy records)
    if let Some(pool) = pool {
        if !raw_id.starts_with(crate::thumbnail::PREFIX) {
            if let Ok(Some(blob)) = query_cover_blob(pool, raw_id, thumb) {
                // Lazy-migrate to filesystem
                if let Some(dir) = cache_dir {
                    let target = thumbnail_path(dir, raw_id, thumb);
                    let _ = crate::thumbnail::atomic_write(&target, &blob);
                }
                if let Ok(mut r) = recorder.lock() {
                    r.record(raw_id);
                }
                let etag = format!("\"{:x}\"", md5::compute(&blob));
                return Ok((etag, Bytes::from(blob)));
            }
        }
    }

    // Step 3: Fallback full→thumb (if exact match and SQLite both failed)
    if !thumb {
        if let Some(dir) = cache_dir {
            let thumb_path = thumbnail_path(dir, raw_id, true);
            if thumb_path.exists() {
                // We found thumb, but full is missing. Emit repair!
                if let Some(pool) = pool {
                    let drive_file_id_opt = if raw_id.starts_with(crate::thumbnail::PREFIX) {
                        Some(raw_id.trim_start_matches(crate::thumbnail::PREFIX).to_string())
                    } else {
                        get_drive_file_id_for_track(pool, raw_id).ok().flatten()
                    };

                    if let Some(drive_file_id) = drive_file_id_opt {
                        if let Some(app) = app {
                            use tauri::Emitter;
                            let payload = serde_json::json!({
                                "driveFileId": drive_file_id,
                                "dbId": raw_id,
                            });
                            let _ = app.emit("repair-missing-thumbnail", payload);
                        }
                    }
                }

                if let Ok(data) = std::fs::read(&thumb_path) {
                    if let Ok(mut r) = recorder.lock() {
                        r.record(raw_id);
                    }
                    let etag = format!("\"{:x}\"", md5::compute(&data));
                    return Ok((etag, Bytes::from(data)));
                }
            }
        }
    }

    // Emit repair if everything failed
    if let Some(pool) = pool {
        let drive_file_id_opt = if raw_id.starts_with(crate::thumbnail::PREFIX) {
            Some(raw_id.trim_start_matches(crate::thumbnail::PREFIX).to_string())
        } else {
            get_drive_file_id_for_track(pool, raw_id).ok().flatten()
        };

        if let Some(drive_file_id) = drive_file_id_opt {
            if let Some(app) = app {
                use tauri::Emitter;
                let payload = serde_json::json!({
                    "driveFileId": drive_file_id,
                    "dbId": raw_id,
                });
                let _ = app.emit("repair-missing-thumbnail", payload);
            }
        }
    }

    Err("not found".into())
}

fn get_drive_file_id_for_track(
    pool: &r2d2::Pool<SqliteConnectionManager>,
    db_id: &str,
) -> Result<Option<String>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let path: Option<String> = conn
        .query_row(
            "SELECT file_path FROM tracks WHERE id = ?",
            [db_id],
            |row| row.get(0),
        )
        .ok();
    Ok(path.and_then(|p| p.strip_prefix("drive://").map(String::from)))
}

fn handle_cover_post(
    raw_id: &str,
    thumb: bool,
    body: &[u8],
    cache_dir: &Path,
) -> Result<(), String> {
    validate_file_id(raw_id)?;
    if body.is_empty() {
        return Err("empty payload".into());
    }
    if body.len() > MAX_COVER_SIZE {
        return Err("payload too large".into());
    }
    let path = thumbnail_path(cache_dir, raw_id, thumb);
    crate::thumbnail::atomic_write(&path, body)?;
    Ok(())
}

fn transparent_pixel() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]
}

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("drplay", move |_app, request, responder| {
        let app_handle = _app.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let uri = request.uri().to_string();
            let parsed_url = match url::Url::parse(&uri) {
                Ok(u) => u,
                Err(_) => {
                    responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(Vec::new()).unwrap());
                    return;
                }
            };

            let method = request.method();
            let path = parsed_url.path().to_string();

            if method == "OPTIONS" {
                responder.respond(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
                        .header("Access-Control-Allow-Headers", "*")
                        .body(Vec::new())
                        .unwrap()
                );
                return;
            }

            // POST /cover/{id} — nhận raw binary body
            if method == "POST" && path.starts_with("/cover/") {
                let raw_id = path.trim_start_matches("/cover/");
                let thumb = parsed_url.query_pairs()
                    .any(|(k, v)| k == "thumb" && v == "true");
                let body = request.body();

                use tauri::Manager;
                let cache_dir = match app_handle.path().app_cache_dir() {
                    Ok(d) => d,
                    Err(_) => {
                        responder.respond(Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(Vec::new()).unwrap());
                        return;
                    }
                };

                match handle_cover_post(raw_id, thumb, body, &cache_dir) {
                    Ok(_) => responder.respond(Response::builder().status(StatusCode::OK).body(Vec::new()).unwrap()),
                    Err(e) => responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(e.into_bytes()).unwrap()),
                }
                return;
            }

            // GET /cover?id={id}&thumb=true|false
            if path == "/cover" {
                let file_id = match parsed_url.query_pairs().find(|(k, _)| k == "id") {
                    Some((_, id)) => id.into_owned(),
                    None => {
                        responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(b"Missing ID".to_vec()).unwrap());
                        return;
                    }
                };

                let thumb = parsed_url.query_pairs().any(|(k, v)| k == "thumb" && v == "true");
                let client_etag = request.headers().get("if-none-match")
                    .and_then(|h| h.to_str().ok().map(|s| s.to_string()));

                use tauri::Manager;
                // Thumbnails are stored under `<app_cache_dir>/.thumbnails` (thumbnail.rs:67),
                // so look them up there — NOT in the db directory. Using the wrong base dir
                // would mean thumbnails are never found, the access recorder never fires, and
                // `gc_thumbnails` would then wipe every real thumbnail.
                let cache_dir = app_handle.path().app_cache_dir().ok();
                let pool_state = app_handle.try_state::<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>();
                let pool = pool_state.map(|p| p.inner().clone());

                let recorder = match ACCESS_RECORDER.get() {
                    Some(r) => r,
                    None => {
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .body(b"Access recorder not initialized".to_vec())
                                .unwrap(),
                        );
                        return;
                    }
                };
                let fetch_result = handle_cover_get(
                    &file_id,
                    thumb,
                    cache_dir.as_deref(),
                    pool.as_ref(),
                    recorder,
                    Some(&app_handle),
                );

                match fetch_result {
                    Ok((etag, bytes_val)) => {
                        if client_etag.as_deref() == Some(etag.as_str()) {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::NOT_MODIFIED)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .body(Vec::new())
                                    .unwrap()
                            );
                        } else {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("Content-Type", "image/jpeg")
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Cache-Control", "public, max-age=31536000, immutable")
                                    .header("ETag", etag)
                                    .body(bytes_val.to_vec())
                                    .unwrap()
                            );
                        }
                    }
                    Err(_) => {
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", "image/png")
                                .header("Access-Control-Allow-Origin", "*")
                                .header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
                                .header("ETag", "\"transparent\"")
                                .body(transparent_pixel())
                                .unwrap()
                        );
                    }
                }
                return;
            }

            // GET /stream?id={id} — redirect to Axum proxy
            if path == "/stream" {
                let file_id = match parsed_url.query_pairs().find(|(k, _)| k == "id") {
                    Some((_, id)) => id.into_owned(),
                    None => {
                        responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(b"Missing ID".to_vec()).unwrap_or_else(|_| Response::new(Vec::new())));
                        return;
                    }
                };
                let port = crate::PROXY_PORT.load(std::sync::atomic::Ordering::SeqCst);

                let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() + crate::STREAM_URL_TTL_SECS;
                let payload = format!("{}:{}:{}", file_id, "", exp);
                let secret = match crate::PROXY_SECRET.get() {
                    Some(s) => s.clone(),
                    None => {
                        responder.respond(Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(b"Proxy not ready".to_vec()).unwrap_or_else(|_| Response::new(Vec::new())));
                        return;
                    }
                };
                let mut mac = match <hmac::Hmac<sha2::Sha256> as hmac::Mac>::new_from_slice(secret.as_bytes()) {
                    Ok(m) => m,
                    Err(_) => {
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .body(b"HMAC init error".to_vec())
                                .unwrap_or_else(|_| Response::new(Vec::new())),
                        );
                        return;
                    }
                };
                mac.update(payload.as_bytes());
                let sig = mac.finalize().into_bytes().iter().map(|b| format!("{:02x}", b)).collect::<String>();

                let redirect_url = format!("http://127.0.0.1:{}/stream?id={}&exp={}&sig={}", port, file_id, exp, sig);

                responder.respond(
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header("Location", redirect_url)
                        .header("Cache-Control", "private, max-age=3600")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new())
                        .unwrap_or_else(|_| Response::new(Vec::new()))
                );
                return;
            }

            responder.respond(Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap());
        });
    })
}
