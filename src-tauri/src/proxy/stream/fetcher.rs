use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use reqwest::Client;
use tauri::Emitter;

use crate::proxy::types::BufferState;
use crate::proxy::drive_error::DriveErr;
use crate::proxy::backoff::{compute_cooldown_secs, equal_jitter, full_jitter};
use crate::proxy::constants::{
    FETCH_RETRY_ATTEMPTS, FETCH_RETRY_BASE_BACKOFF_SECS,
    PREFETCH_BATCH_SLICES, RETRY_DEADLINE_SECS, STREAM_RETRY_DELAY_MS,
};
use crate::proxy::content_type::trim_cached_slice;
use crate::proxy::stream::auth::now_epoch_secs;
use super::drive::fetch_range_from_drive;

pub fn spawn_fetcher(
    client: Client,
    api_url: String,
    token: String,
    track_id: String,
    total_size: u64,
    actual_start: u64,
    actual_end: u64,
    slice_start: u64,
    slice_last: u64,
    desired_total: usize,
    slice_cache: Arc<crate::slice_cache::SliceCache>,
    tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    mut main_disconnect_rx: tokio::sync::watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        let mut current_offset = slice_start;
        let mut buffer_status_emitted = false;
        let mut bytes_sent = 0usize;
        let mut retry_deadline: Option<Instant> = None;
        while current_offset < slice_last {
            tokio::select! {
                biased;
                _ = main_disconnect_rx.changed() => break,
                _ = async {} => {}
            }
            
            // Cache hit path
            if let Some(data) = slice_cache.try_get(&track_id, current_offset).await {
                let mut chunk = (*data).clone();
                let skip = if current_offset == slice_start && actual_start > slice_start {
                    (actual_start - slice_start) as usize
                } else {
                    0
                };
                let remaining = desired_total.saturating_sub(bytes_sent);
                trim_cached_slice(&mut chunk, skip, remaining);

                bytes_sent += chunk.len();
                if !chunk.is_empty() {
                    if tx.send(chunk).await.is_err() {
                        break;
                    }
                }
                current_offset += crate::slice_cache::SLICE_SIZE;
                continue;
            }

            // Cache miss: find consecutive missing slices
            let (fetch_start, count) = slice_cache.find_missing_run(
                &track_id, current_offset, PREFETCH_BATCH_SLICES,
            ).await;

            if fetch_start > current_offset {
                // A background prefetcher just inserted the slice at current_offset
                // into the cache between our try_get and find_missing_run calls.
                // Go back to the top of the loop so the cache-hit path can SEND it,
                // otherwise we would skip sending this slice and corrupt the stream!
                continue;
            }

            if count == 0 {
                continue;
            }

            let fetch_end_slice = fetch_start + (count as u64) * crate::slice_cache::SLICE_SIZE;
            let fetch_end_byte = fetch_end_slice.min(total_size).saturating_sub(1);

            let fetch_result = {
                let fetch_client = client.clone();
                let fetch_api_url = api_url.clone();
                let fetch_token = token.clone();
                let track_id_for_fetch = track_id.clone();
                let slice_cache_for_fetch = slice_cache.clone();
                slice_cache.get_or_fetch(&track_id, fetch_start, move || async move {
                    let mut last_err = None;
                    for attempt in 0..FETCH_RETRY_ATTEMPTS {
                        match fetch_range_from_drive(
                            &fetch_client, &fetch_api_url, &fetch_token,
                            fetch_start, fetch_end_byte,
                        ).await {
                            Ok(data) => {
                                let first_len = (crate::slice_cache::SLICE_SIZE as usize).min(data.len());
                                let first_chunk = data[..first_len].to_vec();
                                if data.len() > first_len {
                                    let rest = data[first_len..].to_vec();
                                    slice_cache_for_fetch.batch_insert(
                                        &track_id_for_fetch,
                                        fetch_start + crate::slice_cache::SLICE_SIZE,
                                        rest,
                                    ).await;
                                }
                                return Ok(first_chunk);
                            }
                            Err(DriveErr::Rate) => {
                                let delay = Duration::from_secs(FETCH_RETRY_BASE_BACKOFF_SECS.checked_shl(attempt).unwrap_or(FETCH_RETRY_BASE_BACKOFF_SECS));
                                tokio::time::sleep(full_jitter(delay)).await;
                                last_err = Some(DriveErr::Rate);
                            }
                            Err(DriveErr::Auth) => return Err(DriveErr::Auth),
                            Err(e @ (DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota)) => return Err(e),
                            Err(e) => {
                                let delay = Duration::from_secs(FETCH_RETRY_BASE_BACKOFF_SECS.checked_shl(attempt).unwrap_or(FETCH_RETRY_BASE_BACKOFF_SECS));
                                tokio::time::sleep(full_jitter(delay)).await;
                                last_err = Some(e);
                            }
                        }
                    }
                    Err(last_err.unwrap_or(DriveErr::Upstream))
                }).await
            };

            match fetch_result {
                Ok(_first_chunk) => {
                    for i in 0..count {
                        let slice_offset = fetch_start + (i as u64) * crate::slice_cache::SLICE_SIZE;
                        if slice_offset > actual_end {
                            break;
                        }
                        if let Some(cached) = slice_cache.try_get(&track_id, slice_offset).await {
                            let mut chunk = (*cached).clone();
                            let skip = if slice_offset == slice_start && actual_start > slice_start {
                                (actual_start - slice_start) as usize
                            } else {
                                0
                            };
                            let remaining = desired_total.saturating_sub(bytes_sent);
                            trim_cached_slice(&mut chunk, skip, remaining);

                            bytes_sent += chunk.len();
                            if !chunk.is_empty() {
                                if tx.send(chunk).await.is_err() {
                                    return;
                                }
                            }
                            // Advance current_offset only when a slice is successfully sent
                            current_offset = slice_offset + crate::slice_cache::SLICE_SIZE;
                        } else {
                            // If we waited for a background prefetcher and it fetched fewer slices
                            // than our `count`, we must stop here. The outer loop will fetch the rest.
                            break;
                        }
                    }

                    if !buffer_status_emitted {
                        buffer_status_emitted = true;
                        let first_batch_end = (fetch_start + (count as u64) * crate::slice_cache::SLICE_SIZE).min(total_size);
                        if let Some(app) = crate::APP_HANDLE.get() {
                            let _ = app.emit("buffer-status", BufferState {
                                track_id: track_id.clone(),
                                buffer_start_byte: 0,
                                buffer_end_byte: first_batch_end,
                                total_size_byte: total_size,
                            });
                        }
                    }

                    retry_deadline = None;
                    crate::proxy::GLOBAL_BACKOFF_UNTIL.store(0, Ordering::Release);
                    crate::proxy::FAIL_COUNT.store(0, Ordering::Relaxed);
                }
                Err(err) => {
                    log::warn!("[proxy] batch-fetch-fail: {:?}", err);
                    match err {
                        DriveErr::NotFound | DriveErr::AccessDenied | DriveErr::DownloadQuota => {
                            break;
                        }
                        DriveErr::Auth => {
                            break;
                        }
                        _ => {
                            if err == DriveErr::Rate {
                                let fail_count = crate::proxy::FAIL_COUNT.fetch_add(1, Ordering::Relaxed);
                                let cooldown = equal_jitter(Duration::from_secs(compute_cooldown_secs(fail_count))).as_secs();
                                crate::proxy::GLOBAL_BACKOFF_UNTIL.store(
                                    now_epoch_secs() + cooldown,
                                    Ordering::Release,
                                );
                            }
                            let deadline = retry_deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(RETRY_DEADLINE_SECS));
                            if Instant::now() >= *deadline {
                                log::error!("[proxy] batch-fetch-retry-exhausted (5s)");
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(STREAM_RETRY_DELAY_MS)).await;
                            continue;
                        }
                    }
                }
            }
        }
    });
}
