use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
