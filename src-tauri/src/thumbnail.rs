use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

pub const PREFIX: &str = "drive_";
const ACCESS_LOG_FLUSH_INTERVAL: usize = 500;
const ACCESS_LOG_FLUSH_SECONDS: u64 = 60;

use std::io::Write;

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let tmp_path = parent.join(format!(
        ".tmp_{}_{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));

    {
        let mut f = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        f.write_all(data).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }

    std::fs::rename(&tmp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    Ok(())
}

pub fn current_epoch() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

pub fn normalize_id(raw: &str) -> String {
    if raw.starts_with(PREFIX) {
        raw.to_string()
    } else {
        format!("{}{}", PREFIX, raw)
    }
}

pub fn validate_file_id(raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err("file_id is empty".into());
    }
    if raw.len() > 128 {
        return Err("file_id too long (max 128)".into());
    }
    if !raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("file_id contains invalid characters: {:?}", raw));
    }
    Ok(())
}

pub fn thumbnail_path(base: &Path, raw_id: &str, thumb: bool) -> PathBuf {
    let normalized = normalize_id(raw_id);
    let suffix = if thumb { "" } else { "_full" };
    let len = normalized.len();
    let s1 = if len >= 2 { &normalized[..2] } else { &normalized[..len] };
    let s2 = if len >= 4 { &normalized[2..4] } else { "xx" };
    base.join(".thumbnails").join(s1).join(s2)
        .join(format!("{}{}.jpg", normalized, suffix))
}

pub struct AccessRecorder {
    entries: VecDeque<String>,
    last_flush: Instant,
    log_path: PathBuf,
}

impl AccessRecorder {
    pub fn new(log_path: PathBuf) -> Self {
        Self {
            entries: VecDeque::new(),
            last_flush: Instant::now(),
            log_path,
        }
    }

    pub fn record(&mut self, raw_id: &str) {
        self.entries.push_back(normalize_id(raw_id));
        if self.entries.len() >= ACCESS_LOG_FLUSH_INTERVAL
            || self.last_flush.elapsed() > Duration::from_secs(ACCESS_LOG_FLUSH_SECONDS)
        {
            self.flush();
        }
    }

    fn flush(&mut self) {
        let mut latest: HashMap<String, u64> = HashMap::new();
        if let Ok(data) = std::fs::read_to_string(&self.log_path) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, u64>>(&data) {
                latest = map;
            }
        }
        while let Some(id) = self.entries.pop_front() {
            latest.insert(id, current_epoch());
        }
        if latest.len() > 5000 {
            let mut vec: Vec<_> = latest.into_iter().collect();
            vec.sort_by_key(|(_, v)| *v);
            latest = vec.into_iter().rev().take(5000).collect();
        }
        if let Ok(json) = serde_json::to_string(&latest) {
            if let Err(e) = atomic_write(&self.log_path, json.as_bytes()) {
                eprintln!(
                    "[AccessRecorder] failed to flush access log {:?}: {}",
                    self.log_path, e
                );
            }
        }
        self.last_flush = Instant::now();
    }
}

pub struct GcPolicy {
    pub max_age_days: u64,
    pub max_size_mb: u64,
}

impl Default for GcPolicy {
    fn default() -> Self {
        Self { max_age_days: 7, max_size_mb: 200 }
    }
}

pub fn gc_thumbnails(thumb_dir: &Path, access_log_path: &Path, policy: &GcPolicy) -> Result<(), String> {
    let access_log: HashMap<String, u64> = std::fs::read_to_string(access_log_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let now = current_epoch();
    let max_age_secs = policy.max_age_days * 86400;
    let max_size_bytes = policy.max_size_mb * 1024 * 1024;

    let mut files: Vec<(PathBuf, u64, u64)> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();

    for entry in WalkDir::new(thumb_dir).min_depth(1).into_iter().filter_map(|e| e.ok()) {
        if entry.path() == access_log_path {
            continue;
        }
        if entry.file_type().is_dir() {
            dirs.push(entry.path().to_path_buf());
            continue;
        }
        let stem = entry.path().file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let lookup_key = stem.trim_end_matches("_full");
        let last_access = access_log.get(lookup_key).copied().unwrap_or(0);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        files.push((entry.path().to_path_buf(), last_access, size));
    }

    let mut to_delete: Vec<PathBuf> = Vec::new();

    // Rule 1: delete files past max_age regardless of size
    for (path, last_access, _) in &files {
        if now.saturating_sub(*last_access) > max_age_secs {
            to_delete.push(path.clone());
        }
    }

    // Rule 2: if total size over limit, delete oldest-first until under limit
    let deleted_set: std::collections::HashSet<_> = to_delete.iter().cloned().collect();
    let mut remaining: Vec<_> = files.iter().filter(|(p, _, _)| !deleted_set.contains(p)).collect();
    remaining.sort_by_key(|(_, last_access, _)| *last_access);

    let mut total_size: u64 = remaining.iter().map(|(_, _, s)| s).sum();
    let mut idx = 0;
    while total_size > max_size_bytes && idx < remaining.len() {
        let file_entry = remaining[idx];
        to_delete.push(file_entry.0.clone());
        total_size = total_size.saturating_sub(file_entry.2);
        idx += 1;
    }

    for path in &to_delete {
        if let Err(e) = std::fs::remove_file(path) {
            eprintln!("[gc_thumbnails] failed to remove file {:?}: {}", path, e);
        }
    }

    // Clean up empty directories (bottom-up)
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for dir in &dirs {
        if dir.read_dir().map(|mut d| d.next().is_none()).unwrap_or(false) {
            if let Err(e) = std::fs::remove_dir(dir) {
                eprintln!("[gc_thumbnails] failed to remove dir {:?}: {}", dir, e);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    fn make_temp_thumb_dir() -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "drplay_gc_test_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn write_thumb(dir: &Path, name: &str, bytes: &[u8]) {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, bytes).unwrap();
    }

    fn write_access_log(dir: &Path, log: &HashMap<String, u64>) {
        let json = serde_json::to_string(log).unwrap();
        fs::write(dir.join("access_log.json"), json).unwrap();
    }

    // F1/F2 positive case: a co-located access_log must keep recently-accessed
    // thumbnails and only drop the aged ones.
    #[test]
    fn gc_deletes_old_keeps_recent_by_age() {
        let dir = make_temp_thumb_dir();
        write_thumb(&dir, "old.jpg", b"olddata");
        write_thumb(&dir, "new.jpg", b"newdata");

        let mut log = HashMap::new();
        log.insert("old".to_string(), now_secs() - 10 * 86400);
        log.insert("new".to_string(), now_secs());
        write_access_log(&dir, &log);

        let policy = GcPolicy {
            max_age_days: 7,
            max_size_mb: 200,
        };
        gc_thumbnails(&dir, &dir.join("access_log.json"), &policy).unwrap();

        assert!(
            !dir.join("old.jpg").exists(),
            "aged thumbnail must be GC'd"
        );
        assert!(
            dir.join("new.jpg").exists(),
            "recently-accessed thumbnail must be kept"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // Size eviction: when total size exceeds the limit, oldest-accessed files are
    // dropped first until under the limit; the most-recently-accessed survives.
    #[test]
    fn gc_evicts_oldest_first_when_over_size() {
        let dir = make_temp_thumb_dir();
        let payload = vec![0u8; 600 * 1024]; // 600 KiB each
        write_thumb(&dir, "a.jpg", &payload); // oldest
        write_thumb(&dir, "b.jpg", &payload);
        write_thumb(&dir, "c.jpg", &payload); // newest

        let mut log = HashMap::new();
        log.insert("a".to_string(), now_secs() - 3000);
        log.insert("b".to_string(), now_secs() - 2000);
        log.insert("c".to_string(), now_secs() - 1000);
        write_access_log(&dir, &log);

        // 3 x 600 KiB = 1.8 MiB total, limit 1 MiB -> drop oldest until <= 1 MiB.
        let policy = GcPolicy {
            max_age_days: 36500, // disable age rule so only size rule applies
            max_size_mb: 1,
        };
        gc_thumbnails(&dir, &dir.join("access_log.json"), &policy).unwrap();

        assert!(!dir.join("a.jpg").exists(), "oldest must be evicted");
        assert!(!dir.join("b.jpg").exists(), "second-oldest must be evicted");
        assert!(dir.join("c.jpg").exists(), "newest must be kept under limit");
        let _ = fs::remove_dir_all(&dir);
    }

    // F2 lock: the access recorder populates `thumb_dir/access_log.json` at runtime.
    // `gc_thumbnails` MUST be called with that exact co-located path. If a caller passes
    // a DIFFERENT path (the historical bug: recorder logged under `get_db_path()/..`
    // while GC read `app_cache_dir()/..`), gc reads an empty/unrelated map => every
    // thumbnail reads as `last_access = 0` and is wiped. This test pins that contract.
    #[test]
    fn gc_mismatched_access_log_wipes_everything() {
        let dir = make_temp_thumb_dir();
        write_thumb(&dir, "keep1.jpg", b"data1");
        write_thumb(&dir, "keep2.jpg", b"data2");

        // Simulate the real runtime: the recorder has populated the CO-LOCATED log with
        // recent accesses.
        let mut log = HashMap::new();
        log.insert("keep1".to_string(), now_secs());
        log.insert("keep2".to_string(), now_secs());
        write_access_log(&dir, &log);

        // Caller mistakenly points gc at a different (unrelated) log path.
        let external_log = dir
            .join("..")
            .join(format!("external_log_{}.json", uuid::Uuid::new_v4().simple()));

        let policy = GcPolicy {
            max_age_days: 7,
            max_size_mb: 200,
        };
        // gc reads the mismatched (empty) log => all thumbnails wiped.
        gc_thumbnails(&dir, &external_log, &policy).unwrap();

        assert!(
            !dir.join("keep1.jpg").exists(),
            "mismatched access_log must cause full wipe of thumbnails"
        );
        assert!(
            !dir.join("keep2.jpg").exists(),
            "mismatched access_log must cause full wipe of thumbnails"
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&external_log);
    }

    // The co-located access_log.json lives in the same dir that WalkDir traverses.
    // It must never be collected as a deletable thumbnail: last_access would be 0 and
    // Rule 1 would wipe it every GC run, resetting the access history. This pins that
    // gc_thumbnails skips the access_log file by exact path.
    #[test]
    fn gc_preserves_access_log() {
        let dir = make_temp_thumb_dir();
        write_thumb(&dir, "abc.jpg", b"thumbdata");

        let access_log_path = dir.join("access_log.json");
        let original_json = r#"{"abc":1234567890}"#.to_string();
        fs::write(&access_log_path, original_json.as_bytes()).unwrap();

        let policy = GcPolicy::default();
        gc_thumbnails(&dir, &access_log_path, &policy).unwrap();

        assert!(
            access_log_path.exists(),
            "access_log.json must not be deleted by GC"
        );
        let after = fs::read_to_string(&access_log_path).unwrap();
        assert_eq!(
            after, original_json,
            "access_log.json content must be preserved unchanged"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
