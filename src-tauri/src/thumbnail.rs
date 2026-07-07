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
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
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
            let _ = atomic_write(&self.log_path, json.as_bytes());
        }
        self.last_flush = Instant::now();
    }
}

#[allow(dead_code)]
pub struct GcPolicy {
    pub max_age_days: u64,
    pub max_size_mb: u64,
}

impl Default for GcPolicy {
    fn default() -> Self {
        Self { max_age_days: 7, max_size_mb: 200 }
    }
}

#[allow(dead_code)]
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
        let _ = std::fs::remove_file(path);
    }

    // Clean up empty directories (bottom-up)
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for dir in &dirs {
        if dir.read_dir().map(|mut d| d.next().is_none()).unwrap_or(false) {
            let _ = std::fs::remove_dir(dir);
        }
    }

    Ok(())
}

pub fn migrate_thumbnail(cache_dir: &Path, old_id: &str, new_id: &str) -> Result<(), String> {
    for thumb in &[true, false] {
        let old = thumbnail_path(cache_dir, old_id, *thumb);
        if !old.exists() {
            continue;
        }
        let new = thumbnail_path(cache_dir, new_id, *thumb);
        if new.exists() {
            let _ = std::fs::remove_file(&old);
            continue;
        }
        if let Some(parent) = new.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let data = std::fs::read(&old).map_err(|e| e.to_string())?;
        atomic_write(&new, &data)?;
    }
    Ok(())
}
