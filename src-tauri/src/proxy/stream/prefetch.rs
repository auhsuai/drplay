use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use reqwest::Client;
use tauri::Emitter;

use crate::proxy::types::BufferState;
use crate::proxy::drive_error::DriveErr;
use crate::proxy::backoff::full_jitter;
use crate::proxy::constants::{PREFETCH_POLL_INTERVAL_MS, PREFETCH_YIELD_MS, PREFETCH_RATE_LIMIT_SLEEP_SECS, PREFETCH_BATCH_SLICES};
use super::drive::fetch_range_from_drive;

pub fn spawn_prefetcher(
    client: Client,
    api_url: String,
    token: String,
    track_id: String,
    total_size: u64,
    start_offset: u64,
    slice_cache: Arc<crate::slice_cache::SliceCache>,
    buffer_seconds: Arc<std::sync::atomic::AtomicUsize>,
    mut disconnect_rx: tokio::sync::watch::Receiver<bool>,
) {
    let cancel = Arc::new(tokio::sync::Notify::new());
    
    let cancel_clone = cancel.clone();
    let bg_id_clone = track_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut guards = crate::proxy::PREFETCH_CANCEL.lock().await;
        if let Some(old) = guards.insert(bg_id_clone, cancel_clone) {
            old.notify_waiters();
        }
    });

    let cancel_for_task = cancel.clone();
    let bg_id_for_task = track_id.clone();
    let sema = crate::proxy::PREFETCH_SEMAPHORE.clone();

    tokio::spawn(async move {
        let _permit = tokio::select! {
            biased;
            _ = cancel_for_task.notified() => return,
            _ = disconnect_rx.changed() => return,
            result = sema.acquire_owned() => match result {
                Ok(permit) => permit,
                Err(_) => return,
            },
        };

        struct CancelGuard {
            id: String,
            signal: Arc<tokio::sync::Notify>,
        }
        impl Drop for CancelGuard {
            fn drop(&mut self) {
                let id = self.id.clone();
                let signal = self.signal.clone();
                tauri::async_runtime::spawn(async move {
                    let mut guards = crate::proxy::PREFETCH_CANCEL.lock().await;
                    if guards.get(&id).map(|s| Arc::ptr_eq(s, &signal)).unwrap_or(false) {
                        guards.remove(&id);
                    }
                });
            }
        }
        let _guard = CancelGuard { id: bg_id_for_task.clone(), signal: cancel_for_task.clone() };

        let max_bytes = {
            let seconds = buffer_seconds.load(Ordering::Relaxed) as u64;
            crate::buffer_bytes_for_seconds(seconds)
        };
        let max_offset = start_offset + max_bytes;
        let mut offset = start_offset;

        while offset < total_size && offset < max_offset {
            tokio::select! {
                _ = cancel_for_task.notified() => break,
                _ = disconnect_rx.changed() => break,
                _ = tokio::time::sleep(std::time::Duration::from_millis(PREFETCH_POLL_INTERVAL_MS)) => {}
            }
            let (first_missing, count) = slice_cache.find_missing_run(&bg_id_for_task, offset, PREFETCH_BATCH_SLICES).await;
            if count == 0 {
                offset += crate::slice_cache::SLICE_SIZE;
                continue;
            }
            let batch_end = (first_missing + (count as u64) * crate::slice_cache::SLICE_SIZE).min(total_size);
            
            let fetch_result = {
                let bg_client = client.clone();
                let bg_url = api_url.clone();
                let bg_token = token.clone();
                let bg_id_for_fetch = bg_id_for_task.clone();
                let slice_cache_for_fetch = slice_cache.clone();
                slice_cache.get_or_fetch(&bg_id_for_task, first_missing, move || async move {
                    let data = fetch_range_from_drive(&bg_client, &bg_url, &bg_token, first_missing, batch_end - 1).await?;
                    let first_len = (crate::slice_cache::SLICE_SIZE as usize).min(data.len());
                    let first_chunk = data[..first_len].to_vec();
                    if data.len() > first_len {
                        let rest = data[first_len..].to_vec();
                        slice_cache_for_fetch.batch_insert(
                            &bg_id_for_fetch,
                            first_missing + crate::slice_cache::SLICE_SIZE,
                            rest,
                        ).await;
                    }
                    Ok(first_chunk)
                }).await
            };
            match fetch_result {
                Ok(_first_chunk) => {
                    if let Some(app) = crate::APP_HANDLE.get() {
                        let _ = app.emit("buffer-status", BufferState {
                            track_id: bg_id_for_task.clone(),
                            buffer_start_byte: 0,
                            buffer_end_byte: batch_end,
                            total_size_byte: total_size,
                        });
                    }
                }
                Err(e) => {
                    log::warn!("[proxy] prefetch-batch-fail at {first_missing}: {e:?}");
                    if matches!(e, DriveErr::Rate) {
                        tokio::time::sleep(full_jitter(Duration::from_secs(PREFETCH_RATE_LIMIT_SLEEP_SECS))).await;
                    }
                }
            }
            offset = batch_end;
            tokio::time::sleep(std::time::Duration::from_millis(PREFETCH_YIELD_MS)).await;
        }
    });
}
