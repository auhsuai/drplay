use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Instant;

use tauri::command;

#[derive(serde::Serialize, Clone)]
pub struct LocalMetadata {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub file_type: String,
}

#[derive(serde::Deserialize)]
pub struct LocalMetadataQuery {
    pub id: String,
    pub size: i64,
    pub name: String,
}

const DB_POOL_MAX_SIZE: u32 = 10;

static DB_LOOKUP_SEMAPHORE: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(DB_POOL_MAX_SIZE as usize));

static HAS_FILE_TYPE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

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

pub fn get_local_metadata_internal(
    size: i64, name: &str, conn: &rusqlite::Connection,
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
        if first_match.is_none() { first_match = Some(meta); }
    }
    first_match
}

#[command]
pub async fn get_local_metadata_batch(
    items: Vec<LocalMetadataQuery>,
    pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>,
) -> Result<HashMap<String, LocalMetadata>, String> {
    let start = Instant::now();
    let item_count = items.len();
    let mut tasks = Vec::with_capacity(item_count);
    for item in items {
        let permit = match DB_LOOKUP_SEMAPHORE.acquire().await {
            Ok(p) => p, Err(_) => continue,
        };
        let pool = (*pool).clone();
        tasks.push(tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let conn = pool.get().ok()?;
            get_local_metadata_internal(item.size, &item.name, &conn).map(|meta| (item.id, meta))
        }));
    }
    let mut results = HashMap::with_capacity(item_count);
    for task in tasks {
        if let Ok(Some((id, meta))) = task.await { results.insert(id, meta); }
    }
    crate::diag_log("get_local_metadata_batch", start.elapsed());
    Ok(results)
}
