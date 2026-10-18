//! Seed offline import (2026-08-10).
//!
//! The Colab scanner produces one `seed.zip` per library scan:
//! `metadata/{fileId}.json` (CachedMetadata v:8 + coverOnDisk + extended
//! fields) and `covers/{t|f}/{s1}/{s2}/{fileId}.jpg` — the exact sharded
//! layout the drplay:// cover GET handler reads (cover.rs:42-94). The
//! Settings "Import metadata backup" button hands the picked zip to
//! `import_metadata_seed`; this module validates EVERY entry (zip-slip,
//! layout, fileId charset, shard dirs, size caps) and writes atomically into
//! `<app_cache_dir>/metadata` + the existing covers root. `read_metadata_disk`
//! serves the imported JSON back to the frontend pipeline (mem → disk → IDB →
//! network), so an imported library renders without any range fetch.

use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use crate::protocol::cover;
use crate::thumbnail::{atomic_write, validate_file_id};

// Named size caps — no magic numbers (metadata JSONs are small; covers can be
// large). Oversized entries are SKIPPED (counted), never fatal.
pub const METADATA_MAX_BYTES: u64 = 1024 * 1024; // 1 MiB
pub const COVER_MAX_BYTES: u64 = 20 * 1024 * 1024; // 20 MiB

const METADATA_ENTRY_PREFIX: &str = "metadata";
const COVERS_ENTRY_PREFIX: &str = "covers";
const METADATA_FILE_EXT: &str = "json";
const COVER_FILE_EXT: &str = "jpg";
const THUMB_VARIANT: &str = "t";
const FULL_VARIANT: &str = "f";

/// Root of the imported metadata JSONs, resolved at `setup` time from
/// `<app_cache_dir>/metadata` (mirrors COVERS_ROOT in protocol/cover.rs).
static METADATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// One import at a time: the import runs on a blocking thread and writes many
/// files; a second concurrent import would interleave writes for no benefit.
static IMPORT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Result of a successful import, returned to the Settings UI for its toast.
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
pub struct ImportStats {
    pub metadata_count: u32,
    pub cover_count: u32,
    pub skipped: u32,
}

/// Initialized from `lib.rs` `setup` with `<app_cache_dir>/metadata`.
pub fn init_metadata_root(root: PathBuf) {
    if METADATA_ROOT.set(root).is_err() {
        eprintln!("[seed] METADATA_ROOT already initialized");
    }
}

/// Clears IMPORT_IN_PROGRESS on drop (panic-safe: a panicking import must not
/// wedge future imports behind a stale flag).
struct ImportGuard;

impl Drop for ImportGuard {
    fn drop(&mut self) {
        IMPORT_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// Unpacks a user-picked seed.zip into `<app_cache_dir>/metadata` + the covers
/// root. Every entry name is validated in an upfront pass BEFORE any file is
/// written, so a single unsafe/invalid entry rejects the whole import with
/// nothing on disk; entries that are merely oversized are skipped and counted.
/// Only name/layout validation is upfront — an IO error while writing (disk
/// full, permission) can still leave a partial import.
#[tauri::command]
pub async fn import_metadata_seed(zip_path: String) -> Result<ImportStats, String> {
    if IMPORT_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err("another metadata import is already running".to_string());
    }
    let _guard = ImportGuard;
    let metadata_root = METADATA_ROOT
        .get()
        .cloned()
        .ok_or_else(|| "metadata root not initialized".to_string())?;
    let covers_root = cover::covers_root()
        .cloned()
        .ok_or_else(|| "covers root not initialized".to_string())?;
    // The zip IO is CPU/disk-bound — run off the async runtime so the IPC
    // handler never blocks on a large archive.
    let import_result = tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&zip_path)
            .map_err(|e| format!("failed to open seed zip: {e}"))?;
        import_seed(file, &metadata_root, &covers_root)
    })
    .await
    .map_err(|e| format!("import task failed: {e}"));
    // The import wrote covers to the SAME disk the drplay:// GET reads, but ids
    // fetched before the import may hold a cached NoCover marker (TTL 1h) —
    // without this they would keep returning 204 after the import. Invalidate
    // on EVERY outcome, not just success: a failed import may already have
    // written part of the covers (partial pass 2) and those must not stay
    // hidden behind a stale marker. Cheap no-op when nothing was written —
    // the cache re-warms from disk on the next GET.
    cover::invalidate_all_covers();
    import_result?
}

/// Reads one imported metadata JSON back to the frontend (disk-first). `None`
/// = no file on disk (the pipeline falls through to IDB/network); IO failures
/// are `Err` so the caller can log and fall through too.
#[tauri::command]
pub fn read_metadata_disk(file_id: String) -> Result<Option<String>, String> {
    let root = METADATA_ROOT
        .get()
        .ok_or_else(|| "metadata root not initialized".to_string())?;
    read_metadata_from_disk(root, &file_id)
}

/// One accepted zip entry: a metadata JSON or one sharded cover JPEG.
enum SeedEntryKind {
    Metadata(String),
    Cover { file_id: String, thumb: bool },
}

/// Classifies + validates a zip entry name against the seed layout. Returns
/// Err for ANY name that is not exactly `metadata/{fileId}.json` or
/// `covers/{t|f}/{s1}/{s2}/{fileId}.jpg` (with a valid fileId and matching
/// shard dirs) — the whitelist is the second layer of the zip-slip defense.
fn classify_seed_entry(name: &str) -> Result<SeedEntryKind, String> {
    // Zip spec mandates '/' separators; a backslash would be ambiguous on
    // Windows (a separator there), so it is rejected outright.
    if name.contains('\\') {
        return Err(format!(
            "entry name contains a backslash (ambiguous separator): {name:?}"
        ));
    }
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() == 2 && parts[0] == METADATA_ENTRY_PREFIX {
        let file_id = parts[1]
            .strip_suffix(&format!(".{METADATA_FILE_EXT}"))
            .filter(|f| !f.is_empty())
            .ok_or_else(|| {
                format!(
                    "metadata entry must be {METADATA_ENTRY_PREFIX}/{{fileId}}.{METADATA_FILE_EXT}: {name:?}"
                )
            })?;
        validate_file_id(file_id)
            .map_err(|e| format!("invalid file id {file_id:?} in {name:?}: {e}"))?;
        return Ok(SeedEntryKind::Metadata(file_id.to_string()));
    }
    if parts.len() == 5 && parts[0] == COVERS_ENTRY_PREFIX {
        let thumb = match parts[1] {
            THUMB_VARIANT => true,
            FULL_VARIANT => false,
            other => {
                return Err(format!(
                    "cover variant must be {THUMB_VARIANT} or {FULL_VARIANT}, got {other:?} in {name:?}"
                ))
            }
        };
        let file_id = parts[4]
            .strip_suffix(&format!(".{COVER_FILE_EXT}"))
            .filter(|f| !f.is_empty())
            .ok_or_else(|| {
                format!(
                    "cover entry must be {COVERS_ENTRY_PREFIX}/{{t|f}}/{{s1}}/{{s2}}/{{fileId}}.{COVER_FILE_EXT}: {name:?}"
                )
            })?;
        validate_file_id(file_id)
            .map_err(|e| format!("invalid file id {file_id:?} in {name:?}: {e}"))?;
        let (s1, s2) = cover::shard_pair(file_id);
        if parts[2] != s1 || parts[3] != s2 {
            return Err(format!(
                "cover shard dirs {}/{} do not match {}/{} for file id {file_id:?}",
                parts[2], parts[3], s1, s2
            ));
        }
        return Ok(SeedEntryKind::Cover {
            file_id: file_id.to_string(),
            thumb,
        });
    }
    Err(format!("unexpected zip entry layout: {name:?}"))
}

/// Core import logic (unit-testable — no tauri dependency). `covers_root` is
/// the same root the cover GET handler reads from, so covers land exactly
/// where drplay:// serves them.
///
/// Two-pass import:
/// 1. Pass 1 validates EVERY entry name before writing anything — zip-slip
///    guard (`enclosed_name()` rejects NULL bytes, absolute paths and
///    `..`-escapes; names must be valid UTF-8) + layout whitelist (only
///    `metadata/{fileId}.json` with a validated fileId and
///    `covers/{t|f}/{s1}/{s2}/{fileId}.jpg` with s1/s2 matching shard_pair).
///    Any violation rejects the WHOLE import with zero files written.
/// 2. Pass 2 reads + writes the pre-validated entries. IO failures here
///    (disk full, permission) can still leave a partial import on disk —
///    validation is upfront, not an atomic multi-file commit.
/// Pure directory entries are skipped silently (Python's zipfile emits them).
/// Oversized entries (metadata > 1 MiB, cover > 20 MiB) are SKIPPED and
/// counted, never fatal — a decompression bomb cannot balloon memory because
/// each entry is read through a bounded `take(limit + 1)`.
pub fn import_seed<R: Read + Seek>(
    reader: R,
    metadata_root: &Path,
    covers_root: &Path,
) -> Result<ImportStats, String> {
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("failed to open zip archive: {e}"))?;

    // Pass 1 — validate every entry name upfront (no body reads, no writes).
    // Storing the classified kind keeps pass 2 free of re-validation.
    let mut planned: Vec<(usize, String, SeedEntryKind)> = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("failed to read zip entry #{index}: {e}"))?;
        // Directory entries (name ends with '/') carry no content — the Colab
        // zip writer emits them; skip silently.
        if entry.is_dir() {
            continue;
        }
        // Zip-slip guard #1: rejects NULL bytes, absolute paths and paths
        // that escape the extraction root. ANY unsafe name aborts the whole
        // import — safety over tolerance.
        if entry.enclosed_name().is_none() {
            return Err(format!(
                "unsafe zip entry name (traversal or absolute path): {:?}",
                entry.name_raw()
            ));
        }
        // The reader may lossily decode non-UTF-8 names — only genuine UTF-8
        // entry names are accepted (the Colab writer emits UTF-8).
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| "zip entry name is not valid UTF-8".to_string())?
            .to_string();
        // Zip-slip guard #2: exact-layout whitelist + fileId charset + shard
        // dirs must match. Rejects the whole import on any violation.
        let kind = classify_seed_entry(&name)?;
        planned.push((index, name, kind));
    }

    // Pass 2 — read + write the validated entries.
    let mut stats = ImportStats {
        metadata_count: 0,
        cover_count: 0,
        skipped: 0,
    };
    for (index, name, kind) in planned {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("failed to read zip entry #{index}: {e}"))?;
        let limit = match kind {
            SeedEntryKind::Metadata(_) => METADATA_MAX_BYTES,
            SeedEntryKind::Cover { .. } => COVER_MAX_BYTES,
        };
        // Decompression-bomb guard: never materialize more than limit+1 bytes
        // per entry; oversized entries are skipped (counted), not fatal.
        let mut buf: Vec<u8> = Vec::new();
        entry
            .by_ref()
            .take(limit + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("failed to read zip entry {name:?}: {e}"))?;
        if buf.len() as u64 > limit {
            stats.skipped += 1;
            eprintln!("[seed] skipped oversized zip entry {name:?} (> {limit} bytes)");
            continue;
        }
        match kind {
            SeedEntryKind::Metadata(file_id) => {
                let dest = metadata_root.join(format!("{file_id}.{METADATA_FILE_EXT}"));
                atomic_write(&dest, &buf)
                    .map_err(|e| format!("failed to write metadata for {file_id:?}: {e}"))?;
                stats.metadata_count += 1;
            }
            SeedEntryKind::Cover { file_id, thumb } => {
                // cover_disk_path is the SAME builder the drplay:// GET uses —
                // imported covers are served on the next GET request.
                let dest = cover::cover_disk_path(covers_root, &file_id, thumb)
                    .map_err(|e| format!("cover path failed for {file_id:?}: {e:?}"))?;
                atomic_write(&dest, &buf)
                    .map_err(|e| format!("failed to write cover for {file_id:?}: {e}"))?;
                stats.cover_count += 1;
            }
        }
    }
    Ok(stats)
}

/// Core read logic (unit-testable — no tauri dependency). `None` = no file on
/// disk; IO failures are `Err` (the caller logs and falls through to the
/// IDB/network pipeline). Reads are capped at METADATA_MAX_BYTES so a corrupt
/// giant file surfaces as an error instead of a memory spike.
pub fn read_metadata_from_disk(root: &Path, file_id: &str) -> Result<Option<String>, String> {
    validate_file_id(file_id).map_err(|e| format!("read_metadata_disk: {e}"))?;
    let path = root.join(format!("{file_id}.{METADATA_FILE_EXT}"));
    match std::fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "read_metadata_disk: failed to stat {}: {e}",
                path.display()
            ))
        }
        Ok(meta) => {
            if meta.len() > METADATA_MAX_BYTES {
                return Err(format!(
                    "read_metadata_disk: metadata file too large: {}",
                    path.display()
                ));
            }
        }
    }
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("read_metadata_disk: failed to read {}: {e}", path.display()))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|e| format!("read_metadata_disk: metadata is not UTF-8: {e}"))
}

#[cfg(test)]
mod tests;
