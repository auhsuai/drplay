import re

LIB_PATH = r"c:\Users\thinkpad\Desktop\Antigravity\drplay\src-tauri\src\lib.rs"
with open(LIB_PATH, "r", encoding="utf-8") as f:
    lib = f.read()

# Update SegmentedCache
cache_struct = """pub struct SegmentedCache {
    pub file_id: String,
    pub content_type: String,
    pub duration: Option<f64>,
    pub total_file_size: usize,
    pub buffer: std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<usize, Vec<u8>>>>,
    pub filled_ranges: std::sync::Arc<tokio::sync::RwLock<Vec<(usize, usize)>>>,
    pub download_state: std::sync::Arc<tokio::sync::RwLock<DownloadState>>,
    pub current_task: std::sync::Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub active_download_pos: std::sync::Arc<tokio::sync::RwLock<usize>>,
    pub max_read_pos: std::sync::Arc<tokio::sync::RwLock<usize>>,
    pub data_ready: std::sync::Arc<tokio::sync::Notify>,
}"""

lib = re.sub(
    r"pub struct SegmentedCache \{.*?\n\}",
    cache_struct,
    lib,
    flags=re.DOTALL
)

# Replace Mutex with Tokio Mutex for GLOBAL_STREAM_CACHE
lib = re.sub(
    r"pub static ref GLOBAL_STREAM_CACHE: std::sync::Mutex<Option<std::sync::Arc<SegmentedCache>>> = std::sync::Mutex::new\(None\);",
    r"pub static ref GLOBAL_STREAM_CACHE: tokio::sync::Mutex<Option<std::sync::Arc<SegmentedCache>>> = tokio::sync::Mutex::new(None);",
    lib
)

# Update get_proxy_cache_status to async
lib = re.sub(
    r"fn get_proxy_cache_status\(\) -> Result<\(String, Vec<\(usize, usize\)>, usize\), String> \{",
    r"async fn get_proxy_cache_status() -> Result<(String, Vec<(usize, usize)>, usize), String> {",
    lib
)
lib = lib.replace("GLOBAL_STREAM_CACHE.lock()", "GLOBAL_STREAM_CACHE.lock().await")
lib = lib.replace("if let Ok(global) = GLOBAL_STREAM_CACHE.lock().await", "let global = GLOBAL_STREAM_CACHE.lock().await; if true")

with open(LIB_PATH, "w", encoding="utf-8") as f:
    f.write(lib)

print("Updated lib.rs")
