use std::time::Duration;

// --- Named constants: no magic numbers / strings on the production path ---
// Reqwest total per-request timeout (conn + read). Bounds every Drive call so a
// stalled socket cannot hang a stream task forever.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// Bounded wait for a fresh OAuth token via the global Notify.
pub const TOKEN_RECOVERY_TIMEOUT: Duration = Duration::from_secs(8);
// Retry attempts for a transient Drive batch fetch before giving up.
pub const FETCH_RETRY_ATTEMPTS: u32 = 3;
// Base (seconds) for exponential backoff between fetch retries: 1 << attempt.
pub const FETCH_RETRY_BASE_BACKOFF_SECS: u64 = 1;
// Bounded mpsc buffer between the fetch task and the streaming response.
pub const STREAM_CHANNEL_BOUND: usize = 8;
// Consecutive slices fetched/looked-up in one batch (find_missing_run count).
pub const PREFETCH_BATCH_SLICES: usize = 4;
// Global rate-limit cooldown: base seconds, hard cap, and shift exponent cap.
pub const COOLDOWN_BASE_SECS: u64 = 30;
pub const COOLDOWN_MAX_SECS: u64 = 300;
pub const COOLDOWN_EXP_CAP: u32 = 4;
// Overall transient-retry budget for one stream (not per-attempt).
pub const RETRY_DEADLINE_SECS: u64 = 5;
// Sleep when a background prefetch hits a rate limit.
pub const PREFETCH_RATE_LIMIT_SLEEP_SECS: u64 = 5;
// Delay between transient retry attempts in the main fetch loop.
pub const STREAM_RETRY_DELAY_MS: u64 = 500;
// Poll interval / yield for the background prefetch task.
pub const PREFETCH_POLL_INTERVAL_MS: u64 = 250;
pub const PREFETCH_YIELD_MS: u64 = 100;
// Fallback total size (10 MB) and Content-Type used only when Drive cannot be
// probed (network down). Never forwarded as a real value to the WebView logic.
pub const DEFAULT_TOTAL_SIZE_FALLBACK: u64 = 10_000_000;
pub const FALLBACK_CONTENT_TYPE: &str = "audio/mpeg";
