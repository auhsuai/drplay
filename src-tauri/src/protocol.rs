use tauri::http::{Response, StatusCode};
use moka::future::Cache;
use bytes::Bytes;
use hmac::Mac;
use once_cell::sync::Lazy;
use std::time::Duration;
use std::time::Instant;

use r2d2_sqlite::SqliteConnectionManager;

use crate::thumbnail::validate_file_id;

// --- Named constants for the in-RAM cover cache (no magic numbers) ---
// Total RAM budget for decoded cover bytes held in the moka cache. The weigher
// counts each entry's byte length, so the cache evicts (LRU + TinyLFU admission)
// once the summed weight passes this cap — preventing unbounded growth / OOM.
const COVER_CACHE_MAX_BYTES: usize = 384 * 1024 * 1024; // 384 MiB
// Entries expire after this idle/write TTL so stale covers are re-fetched from R2.
const COVER_CACHE_TTL_SECS: u64 = 3600; // 1 hour
// Max size accepted for an incoming POSTed cover payload (legacy local-cover path).
const MAX_COVER_SIZE: usize = 52_428_800;
/// Sentinel etag stored in COVER_CACHE when a track has no cover (NoCover).
/// Checking this in step 0 avoids re-fetching from R2 + SQLite on every mount.
const COVER_NOCOVER_ETAG: &str = "\"nocover\"";

// Cache key suffix marking the thumbnail (downscaled) vs full variant.
fn cover_cache_key(raw_id: &str, thumb: bool) -> String {
    format!("{}_{}", raw_id, if thumb { 't' } else { 'f' })
}

// Initialized from `lib.rs` `setup` with a log path under `<app_cache_dir>/.thumbnails/`.
// The cover GET path records each access here; the handler returns HTTP 500 if the
// recorder has not been initialized, so `init_access_recorder` must run at setup.
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

// In-RAM, bounded, TTL-expiring cover cache. Keyed by `{music_id}_{t|f}` (t = thumb,
// f = full). Source of truth stays in R2 (aws-sdk-s3); this cache only avoids
// re-fetching the same cover bytes on every UI paint. Bounded by total BYTES via the
// weigher and by time via TTL — no unbounded growth, no disk writes.
pub static COVER_CACHE: Lazy<Cache<String, (String, Bytes)>> = Lazy::new(|| {
    Cache::builder()
        .max_capacity(COVER_CACHE_MAX_BYTES as u64)
        .weigher(|_k, v: &(String, Bytes)| v.1.len() as u32)
        .time_to_live(Duration::from_secs(COVER_CACHE_TTL_SECS))
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

fn query_cover_url(
    pool: &r2d2::Pool<SqliteConnectionManager>,
    file_id: &str,
) -> Option<(Option<String>, Option<String>)> {
    let conn = pool.get().ok()?;
    let has_cover_url = *crate::HAS_COVER_URL.get_or_init(|| {
        conn.prepare("SELECT cover_url FROM tracks LIMIT 1").is_ok()
    });
    if !has_cover_url {
        return None;
    }
    let path: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT cover_url, thumb_url FROM tracks WHERE id = ?",
            [file_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    Some(path)
}

// Async priority 0: if the DB row carries an R2 object key (cover_url/thumb_url),
// fetch the bytes directly from R2 server-side. Keeps R2 credentials off the JS
// layer — the webview still only sees http://drplay.localhost/cover?...
async fn handle_cover_get_r2(
    raw_id: &str,
    _thumb: bool,
    pool: Option<&r2d2::Pool<SqliteConnectionManager>>,
) -> Option<(String, Bytes)> {
    let (cover_url, thumb_url) = match pool.and_then(|p| query_cover_url(p, raw_id)) {
        Some(v) => v,
        None => return None,
    };
    // Legacy DB rows sometimes have cover_url/thumb_url SWAPPED or store a
    // bogus value (e.g. the file extension "mp3") in one of the columns.
    // Accept whichever column holds a valid R2 key ("covers/..."); the webview
    // scales the full image down for thumbnails, so either key works.
    let key = cover_url.as_ref().filter(|k| k.starts_with("covers/"))
        .or_else(|| thumb_url.as_ref().filter(|k| k.starts_with("covers/")));
    let key = match key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return None,
    };
    match crate::r2::get_cover_bytes(key).await {
        Ok(data) => {
            let etag = format!("\"{:x}\"", md5::compute(&data));
            Some((etag, Bytes::from(data)))
        }
        Err(_e) => None
    }
}

async fn handle_cover_get<R: tauri::Runtime>(
    raw_id: &str,
    thumb: bool,
    pool: Option<&r2d2::Pool<SqliteConnectionManager>>,
    recorder: &std::sync::Mutex<crate::thumbnail::AccessRecorder>,
    app: Option<&tauri::AppHandle<R>>,
) -> Result<(String, Bytes, &'static str), CoverError> {
    let start = Instant::now();
    if let Err(e) = validate_file_id(raw_id) {
        eprintln!("[DIAG] handle_cover_get took {:?} (BadId)", start.elapsed());
        return Err(CoverError::BadId(e));
    }

    let cache_key = cover_cache_key(raw_id, thumb);

    // Step 0: in-RAM cache (bounded, TTL). Hits avoid any R2/DB round trip.
    if let Some(hit) = COVER_CACHE.get(&cache_key).await {
        if hit.0 == COVER_NOCOVER_ETAG {
            return Err(CoverError::NoCover);
        }
        if let Ok(mut r) = recorder.lock() {
            r.record(raw_id);
        }
        return Ok((hit.0, hit.1, "image/jpeg"));
    }

    // Step 1: R2 object storage (server-side fetch of cover_url/thumb_url).
    if let Some(r2_result) = handle_cover_get_r2(raw_id, thumb, pool).await {
        COVER_CACHE.insert(cache_key, r2_result.clone()).await;
        if let Ok(mut r) = recorder.lock() {
            r.record(raw_id);
        }
        eprintln!("[DIAG] handle_cover_get took {:?} (R2 fetch)", start.elapsed());
        return Ok((r2_result.0, r2_result.1, "image/jpeg"));
    }

    // Step 2: SQLite blob fallback — only for ids without drive_ prefix (legacy records)
    if let Some(pool) = pool {
        if !raw_id.starts_with(crate::thumbnail::PREFIX) {
            if let Ok(Some(blob)) = query_cover_blob(pool, raw_id, thumb) {
                let etag = format!("\"{:x}\"", md5::compute(&blob));
                let bytes = Bytes::from(blob);
                COVER_CACHE.insert(cache_key, (etag.clone(), bytes.clone())).await;
                if let Ok(mut r) = recorder.lock() {
                    r.record(raw_id);
                }
                eprintln!("[DIAG] handle_cover_get took {:?} (SQLite blob)", start.elapsed());
                return Ok((etag, bytes, "image/jpeg"));
            }
        }
    }

    // Step 3: No real cover anywhere (no R2 key, no SQLite blob). Emit a repair
    // signal if we can map to a Drive file, then return the music-note placeholder
    // so the UI never shows a black/transparent image. `has_cover` on the JS side
    // stays false, so the app knows there is no real cover.
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

    // Cache the "no cover" result so subsequent requests skip R2/SQLite.
    COVER_CACHE.insert(cache_key, (COVER_NOCOVER_ETAG.to_string(), Bytes::new())).await;
    eprintln!("[DIAG] handle_cover_get took {:?} (NoCover)", start.elapsed());
    Err(CoverError::NoCover)
}

#[derive(Debug)]
enum CoverError {
    BadId(String),
    NoCover,
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
    _thumb: bool,
    body: &[u8],
) -> Result<(), String> {
    validate_file_id(raw_id)?;
    if body.is_empty() {
        return Err("empty payload".into());
    }
    if body.len() > MAX_COVER_SIZE {
        return Err("payload too large".into());
    }
    // Covers now live in R2 (server-side, keyed by cover_url/thumb_url) and are
    // served from the in-RAM cache. We no longer persist cover bytes to disk, so
    // this legacy local-cover write is intentionally a no-op: accepting the
    // payload keeps the protocol contract stable without growing `.thumbnails/`.
    Ok(())
}

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("drplay", move |_app, request, responder| {
        let app_handle = _app.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let uri = request.uri().to_string();
            let parsed_url = match url::Url::parse(&uri) {
                Ok(u) => u,
                Err(_) => {
                    responder.respond(
                        Response::builder()
                            .status(StatusCode::BAD_REQUEST)
                            .body(Vec::new())
                            .unwrap_or_else(|e| {
                                eprintln!("[protocol] failed to build BAD_REQUEST (invalid URI) response: {e}");
                                Response::new(Vec::new())
                            }),
                    );
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
                        .unwrap_or_else(|e| {
                            eprintln!("[protocol] failed to build OPTIONS response: {e}");
                            Response::new(Vec::new())
                        })
                );
                return;
            }

            // POST /cover/{id} — nhận raw binary body (legacy local-cover path).
            if method == "POST" && path.starts_with("/cover/") {
                let raw_id = path.trim_start_matches("/cover/");
                let thumb = parsed_url.query_pairs()
                    .any(|(k, v)| k == "thumb" && v == "true");
                let body = request.body();

                match handle_cover_post(raw_id, thumb, body) {
                    Ok(_) => responder.respond(Response::builder().status(StatusCode::OK).body(Vec::new()).unwrap_or_else(|e| {
                        eprintln!("[protocol] failed to build 200 (cover POST) response: {e}");
                        Response::new(Vec::new())
                    })),
                    Err(e) => responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(e.into_bytes()).unwrap_or_else(|e| {
                        eprintln!("[protocol] failed to build 400 (cover POST) response: {e}");
                        Response::new(Vec::new())
                    })),
                }
                return;
            }

            // GET /cover?id={id}&thumb=true|false
            if path == "/cover" {
                let file_id = match parsed_url.query_pairs().find(|(k, _)| k == "id") {
                    Some((_, id)) => id.into_owned(),
                    None => {
                        responder.respond(Response::builder().status(StatusCode::BAD_REQUEST).body(b"Missing ID".to_vec()).unwrap_or_else(|e| {
                            eprintln!("[protocol] failed to build 400 (cover missing id) response: {e}");
                            Response::new(Vec::new())
                        }));
                        return;
                    }
                };

                let thumb = parsed_url.query_pairs().any(|(k, v)| k == "thumb" && v == "true");
                let client_etag = request.headers().get("if-none-match")
                    .and_then(|h| h.to_str().ok().map(|s| s.to_string()));

                use tauri::Manager;
                let pool_state = app_handle.try_state::<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>();
                let pool = pool_state.map(|p| p.inner().clone());

                let recorder = match ACCESS_RECORDER.get() {
                    Some(r) => r,
                    None => {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                                    .body(b"Access recorder not initialized".to_vec())
                                    .unwrap_or_else(|e| {
                                        eprintln!("[protocol] failed to build 500 (access recorder) response: {e}");
                                        Response::new(Vec::new())
                                    }),
                            );
                        return;
                    }
                };
                let fetch_result = handle_cover_get(
                    &file_id,
                    thumb,
                    pool.as_ref(),
                    recorder,
                    Some(&app_handle),
                ).await;

                match fetch_result {
                    Ok((etag, bytes_val, content_type)) => {
                        if client_etag.as_deref() == Some(etag.as_str()) {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::NOT_MODIFIED)
                                    .header("Access-Control-Allow-Origin", "*")
                                .body(Vec::new())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 304 (not modified) response: {e}");
                                    Response::new(Vec::new())
                                })
                            );
                        } else {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("Content-Type", content_type)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Cache-Control", "public, max-age=31536000, immutable")
                                    .header("ETag", etag)
                                .body(bytes_val.to_vec())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 200 (cover) response: {e}");
                                    Response::new(Vec::new())
                                })
                            );
                        }
                    }
                    Err(CoverError::BadId(e)) => {
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::BAD_REQUEST)
                                .body(e.into_bytes())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 400 (bad id) response: {e}");
                                    Response::new(Vec::new())
                                })
                        );
                    }
                    Err(CoverError::NoCover) => {
                        // No real cover anywhere (no R2 key, no SQLite blob). Return
                        // 204 No Content with an empty body so the browser <img> onError
                        // fires and the frontend shows its own Music icon. `has_cover`
                        // on the JS side is already false for this case. R2/DB errors
                        // fall through here too (not a 500), per AGENTS.md Luật 4 —
                        // we never panic and never surface internal errors to the client.
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::NO_CONTENT)
                                .header("Access-Control-Allow-Origin", "*")
                                .body(Vec::new())
                                .unwrap_or_else(|e| {
                                    eprintln!("[protocol] failed to build 204 (no cover) response: {e}");
                                    Response::new(Vec::new())
                                })
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

            responder.respond(Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap_or_else(|e| {
                eprintln!("[protocol] failed to build 404 response: {e}");
                Response::new(Vec::new())
            }));
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cover_cache_stores_and_fetches_by_key() {
        let cache: Cache<String, (String, Bytes)> = Cache::builder()
            .max_capacity(1_000)
            .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
            .time_to_live(Duration::from_secs(60))
            .build();

        let key = cover_cache_key("abc123", true);
        assert!(cache.get(&key).await.is_none(), "fresh cache must miss");

        let payload = Bytes::from(vec![1u8, 2, 3, 4, 5]);
        cache.insert(key.clone(), ("\"etag\"".to_string(), payload.clone())).await;
        let got = cache.get(&key).await;
        assert!(got.is_some(), "inserted entry must be fetchable");
        assert_eq!(got.unwrap().1, payload);

        // Different thumb/full variant is a separate key.
        assert!(cache.get(&cover_cache_key("abc123", false)).await.is_none());
    }

    #[tokio::test]
    async fn cover_cache_evicts_under_byte_capacity() {
        // Tiny capacity forces eviction once summed weights exceed the cap.
        let cache: Cache<String, (String, Bytes)> = Cache::builder()
            .max_capacity(10) // 10 bytes total
            .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
            .build();

        // Insert two 8-byte entries (16 bytes > 10 capacity).
        cache.insert("a".to_string(), ("e".to_string(), Bytes::from(vec![0u8; 8]))).await;
        cache.insert("b".to_string(), ("e".to_string(), Bytes::from(vec![1u8; 8]))).await;

        // Drain maintenance tasks so eviction is applied.
        cache.run_pending_tasks().await;

        // At most one 8-byte entry can remain under a 10-byte cap.
        let a = cache.get(&"a".to_string()).await;
        let b = cache.get(&"b".to_string()).await;
        let present = a.is_some() as u32 + b.is_some() as u32;
        assert!(present <= 1, "byte cap must evict down to <=1 entry, got {}", present);
    }
}
