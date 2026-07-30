use rusqlite::Connection;
use crate::{HAS_COVER_URL, HAS_EXTENDED_META, HAS_DURATION_ESTIMATED};

pub fn configure_sqlite_durability(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;").map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run_migrations(conn: &Connection) {
    configure_sqlite_durability(conn).ok();

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

    // Migration: add duration_estimated flag column so old DBs (scanned
    // before duration estimation) still open. DEFAULT 1 = "duration needs
    // (re)estimation"; update_track_duration_in_db sets it to 0 once a real
    // duration is stored.
    let has_duration_estimated = *HAS_DURATION_ESTIMATED.get_or_init(|| {
        conn.prepare("SELECT duration_estimated FROM tracks LIMIT 1").is_ok()
    });
    if !has_duration_estimated {
        let _ = conn.execute(
            "ALTER TABLE tracks ADD COLUMN duration_estimated INTEGER DEFAULT 1",
            [],
        );
    }

    // Migration: add index on size_bytes for fast metadata lookup.
    // get_local_metadata queries by size_bytes — without index every
    // SongCard mount does a full table scan (~12K rows).
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tracks_size_bytes ON tracks(size_bytes);"
    );
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tracks_id ON tracks(id);"
    );
}
