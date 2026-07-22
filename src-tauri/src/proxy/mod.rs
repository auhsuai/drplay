pub mod backoff;
pub mod cache;
pub mod constants;
pub mod content_type;
pub mod drive_error;
pub mod range;
pub mod stream;
pub mod types;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64};
use std::sync::{Arc, LazyLock};

use reqwest::Client;
use tokio::sync::Mutex;

use self::constants::REQUEST_TIMEOUT;
use self::types::AppState;

// Global state
pub static GLOBAL_BACKOFF_UNTIL: AtomicU64 = AtomicU64::new(0);
pub static FAIL_COUNT: AtomicU32 = AtomicU32::new(0);

/// Per-track cancel signal for background prefetch tasks. When a new stream
/// request arrives for a track, the previous prefetch task (if any) is
/// signalled to stop so it stops filling the slice cache.
static PREFETCH_CANCEL: LazyLock<Arc<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Global concurrency limit for background prefetch tasks. Without this,
/// virtual scroll renders ~20 visible tracks and each one spawns a prefetch
/// task that wakes every 250ms, drives 50% CPU, and floods Google Drive
/// with HEAD + range requests.
static PREFETCH_SEMAPHORE: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(4)));

pub fn start_proxy() {
    tauri::async_runtime::spawn(async move {
        let client = match Client::builder().timeout(REQUEST_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[proxy] reqwest client build failed (timeout={REQUEST_TIMEOUT:?}): {e}");
                Client::new()
            }
        };
        let state = AppState {
            client,
            cache_store: cache::new_cache_store(),
        };

        let app = axum::Router::new()
            .route("/stream", axum::routing::get(stream::handle_stream).head(stream::handle_stream).options(stream::handle_options))
            .with_state(state);

        if let Ok(listener) = tokio::net::TcpListener::bind("127.0.0.1:0").await {
            if let Ok(addr) = listener.local_addr() {
                crate::PROXY_PORT.store(addr.port(), std::sync::atomic::Ordering::SeqCst);
                println!("Proxy server bound to port {}", addr.port());
            }
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("Proxy server error: {}", e);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::Mutex;

    use super::stream::now_epoch_secs;
    use super::backoff::{compute_cooldown_secs, equal_jitter, full_jitter};
    use super::cache::{TrackMeta, CacheStore, new_cache_store, TRACK_CACHE_MAX_ENTRIES};
    use super::content_type::content_type_for_ext;
    use super::drive_error::{classify_drive_error, extract_drive_reason, drive_err_response, DriveErr};
    use super::range::parse_multi_range;

    #[test]
    fn full_jitter_stays_within_0_and_delay() {
        let delay = Duration::from_secs(4);
        for _ in 0..200 {
            let d = full_jitter(delay);
            assert!(d <= delay, "full_jitter produced {d:?} > delay {delay:?}");
        }
    }

    #[test]
    fn full_jitter_of_zero_delay_is_zero() {
        let d = full_jitter(Duration::from_millis(0));
        assert!(d <= Duration::from_millis(1));
    }

    #[test]
    fn equal_jitter_never_drops_below_half_the_delay() {
        let delay = Duration::from_secs(30);
        for _ in 0..200 {
            let d = equal_jitter(delay);
            assert!(d >= delay / 2, "equal_jitter produced {d:?} < half of {delay:?}");
            assert!(d <= delay, "equal_jitter produced {d:?} > delay {delay:?}");
        }
    }

    #[test]
    fn compute_cooldown_secs_matches_handle_rate_limit_formula() {
        assert_eq!(compute_cooldown_secs(0), 30);
        assert_eq!(compute_cooldown_secs(1), 60);
        assert_eq!(compute_cooldown_secs(2), 120);
        assert_eq!(compute_cooldown_secs(3), 240);
        assert_eq!(compute_cooldown_secs(4), 300);
        assert_eq!(compute_cooldown_secs(100), 300);
    }

    fn assemble_chunks_in_order(chunks: &[(u64, u64, Vec<u8>)]) -> Vec<u8> {
        let mut buffer = Vec::with_capacity(chunks.iter().map(|c| c.2.len()).sum());
        for (_, _, data) in chunks {
            buffer.extend_from_slice(data);
        }
        buffer
    }

    #[tokio::test]
    async fn test_parallel_chunks_maintain_order() {
        let chunks = vec![
            (0, 1999, vec![1u8; 2000]),
            (2000, 3999, vec![2u8; 2000]),
            (4000, 5999, vec![3u8; 2000]),
        ];
        let buffer = assemble_chunks_in_order(&chunks);
        assert_eq!(buffer.len(), 6000);
        assert_eq!(buffer[0], 1);
        assert_eq!(buffer[2000], 2);
        assert_eq!(buffer[4000], 3);
    }

    #[test]
    fn test_content_type_for_ext_maps_flac_and_is_case_insensitive() {
        assert_eq!(content_type_for_ext("flac"), Some("audio/flac"));
        assert_eq!(content_type_for_ext("FLAC"), Some("audio/flac"));
        assert_eq!(content_type_for_ext("Ogg"), Some("audio/ogg"));
        assert_eq!(content_type_for_ext("wav"), Some("audio/wav"));
        assert_eq!(content_type_for_ext("m4a"), Some("audio/mp4"));
        assert_eq!(content_type_for_ext("aac"), Some("audio/aac"));
        assert_eq!(content_type_for_ext("mp3"), Some("audio/mpeg"));
        assert_eq!(content_type_for_ext("xyz"), None);
        assert_eq!(content_type_for_ext(""), None);
    }

    #[tokio::test]
    async fn test_track_cache_is_bounded_and_evicts() {
        let cache = new_cache_store();
        let cap = TRACK_CACHE_MAX_ENTRIES;

        for i in 0..(cap * 5) {
            let meta = Arc::new(Mutex::new(TrackMeta {
                total_size: 1_000_000,
                content_type: "audio/mpeg".to_string(),
            }));
            cache.insert(format!("track-{i}"), meta).await;
        }

        cache.run_pending_tasks().await;

        let count = cache.entry_count();
        assert!(
            count <= cap,
            "track cache must stay bounded (<= {cap}), but held {count} entries"
        );
    }

    #[tokio::test]
    async fn test_watch_disconnect_signals_task() {
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(async move {
            let _ = rx.changed().await;
            let _ = done_tx.send(());
        });

        drop(tx);

        tokio::time::timeout(Duration::from_secs(1), done_rx)
            .await
            .expect("task not notified of disconnect within 1s")
            .expect("oneshot channel closed");
    }

    #[test]
    fn test_drive_error_download_quota_is_not_retryable() {
        let body = r#"{"error":{"errors":[{"reason":"downloadQuotaExceeded"}]}}"#;
        assert!(matches!(classify_drive_error(403, body), DriveErr::DownloadQuota));
    }

    #[test]
    fn test_drive_error_notfound_identified() {
        let body = r#"{"error":{"errors":[{"reason":"notFound"}]}}"#;
        assert!(matches!(classify_drive_error(404, body), DriveErr::NotFound));
    }

    #[test]
    fn test_drive_error_rate_limit_identified() {
        let body = r#"{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}"#;
        assert!(matches!(classify_drive_error(429, body), DriveErr::Rate));
    }

    #[test]
    fn test_extract_drive_reason_returns_first_reason() {
        let body = r#"{"error":{"errors":[{"reason":"notFound"},{"reason":"rateLimitExceeded"}]}}"#;
        assert_eq!(extract_drive_reason(body), Some("notfound".to_string()));
    }

    #[test]
    fn test_parse_multi_range_single_with_end() {
        let ranges = parse_multi_range("bytes=0-499", 1000);
        assert_eq!(ranges, vec![(0, 499)]);
    }

    #[test]
    fn test_parse_multi_range_single_without_end() {
        let ranges = parse_multi_range("bytes=500-", 1000);
        assert_eq!(ranges, vec![(500, 999)]);
    }

    #[test]
    fn test_parse_multi_range_suffix_range() {
        let ranges = parse_multi_range("bytes=-500", 1000);
        assert_eq!(ranges, vec![(500, 999)]);
    }

    #[test]
    fn test_parse_multi_range_multiple_ranges() {
        let ranges = parse_multi_range("bytes=0-99,200-299", 1000);
        assert_eq!(ranges, vec![(0, 99), (200, 299)]);
    }

    #[test]
    fn test_parse_multi_range_start_beyond_total() {
        let ranges = parse_multi_range("bytes=2000-3000", 1000);
        assert!(ranges.is_empty());
    }

    #[test]
    fn test_parse_multi_range_empty_header() {
        let ranges = parse_multi_range("", 1000);
        assert!(ranges.is_empty());
    }
}
