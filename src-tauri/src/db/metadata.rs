use std::time::Instant;
use tauri::command;
use crate::{HAS_FILE_TYPE, HAS_COVER_URL, HAS_EXTENDED_META};
use crate::diag_log;

#[derive(serde::Serialize, Clone)]
pub struct LocalMetadata {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub has_cover: bool,
    pub file_type: String,
    pub cover_url: Option<String>,
    pub thumb_url: Option<String>,
    pub bitrate: i64,
    pub sample_rate: i64,
    pub bit_depth: i64,
    pub channels: i64,
    pub genre: String,
    pub year: i64,
    pub track_number: i64,
    pub album_artist: String,
}

#[derive(serde::Serialize, Clone)]
pub struct TrackDataBundle {
    pub metadata: LocalMetadata,
    pub stream_url: String,
}

pub fn get_local_metadata_internal(
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

#[command]
pub fn get_local_metadata(
    size: i64,
    name: String,
    pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>,
    #[allow(unused_variables)]
    _app_handle: tauri::AppHandle,
) -> Option<LocalMetadata> {
    let start = Instant::now();
    let conn = pool.get().ok()?;
    let meta = get_local_metadata_internal(size, &name, &conn)?;

    let dur = start.elapsed();
    diag_log("get_local_metadata", dur);
    Some(meta)
}

#[command]
pub fn get_track_data(
    file_id: String,
    size: i64,
    name: String,
    pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>,
    _bitrate: Option<f64>,
    _buffer_seconds: Option<f64>,
    _ext: Option<String>,
    #[allow(unused_variables)]
    _app_handle: tauri::AppHandle,
) -> Option<TrackDataBundle> {
    let start = Instant::now();
    let conn = pool.get().ok()?;
    let meta = get_local_metadata_internal(size, &name, &conn)?;
    let stream_url = format!("/drive-stream/{}", file_id);
    let dur = start.elapsed();
    diag_log("get_track_data", dur);
    Some(TrackDataBundle { metadata: meta, stream_url })
}

#[command]
pub fn verify_track_exists(db_id: String, pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>) -> bool {
    let conn = match pool.get() {
        Ok(c) => c,
        Err(_) => return true,
    };
    conn.query_row("SELECT 1 FROM tracks WHERE id = ?", [&db_id], |_| Ok(()))
        .is_ok()
}

#[command]
pub async fn update_track_duration_in_db(
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

#[command]
pub async fn clear_local_cache(_app: tauri::AppHandle) -> Result<(), String> {
    crate::protocol::cover::COVER_CACHE.invalidate_all();
    crate::protocol::cover::ETAG_CACHE.invalidate_all();
    Ok(())
}
