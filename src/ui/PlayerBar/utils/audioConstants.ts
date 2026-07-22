// Threshold (seconds) within which an `ended` event is treated as "truly at the
// end of the track". An `ended` firing while currentTime is far from duration is
// a spurious/early-ended event (e.g. caused by a mid-track src reload) and must
// NOT trigger a track skip.
export const ENDED_THRESHOLD_SEC = 1.0;

// Safety window (ms) after a programmatic reload during which any stray `ended`
// event is suppressed. Guarantees the suppress flag cannot stay stuck forever
// even if `canplay` never fires.
export const SUPPRESS_ENDED_SAFETY_MS = 15000;

// --- Named timeouts / backoffs (no magic numbers) ---
// How long to wait for `loadedmetadata` / `canplay` after (re)loading a source.
export const LOAD_METADATA_TIMEOUT_MS = 10_000;
export const CANPLAY_TIMEOUT_MS = 30_000;
// HEAD probe against the proxy used to distinguish transient vs permanent errors.
export const HEAD_PROBE_TIMEOUT_MS = 5_000;
export const HEAD_PROBE_MAX_ATTEMPTS = 3;
export const HEAD_PROBE_BACKOFF_BASE_MS = 500;
// Cooldown applied when the proxy reports a rate-limited (429) state.
export const RATE_LIMIT_COOLDOWN_MS = 300_000;
// Window after a token refresh during which a decode error is retried (the proxy
// may still be recovering) instead of being treated as definitive.
export const TOKEN_RECENCY_WINDOW_MS = 15_000;
// Bounds (ms) for the backoff before auto-retrying after a rate-limited state.
export const RATE_LIMIT_RETRY_MIN_MS = 5_000;
export const RATE_LIMIT_RETRY_MAX_MS = 60_000;
