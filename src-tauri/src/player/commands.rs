use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use log::{error, info, warn};
use rodio::{Decoder, OutputStreamBuilder, Sink, Source};

use super::state::{PLAYER, PLAY_GENERATION, AUDIO_OUTPUT};
use super::stream_reader::{StreamingReader, SharedReader};
use super::probe::{estimate_duration_from_size, probe_duration_from_stream};
use super::fade_source::FadeableSource;

static NO_REDIRECT_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("no-redirect blocking client")
});

pub fn init_player() {
    let t0 = Instant::now();
    let mut state = PLAYER.lock().expect("player state lock");
    match OutputStreamBuilder::open_default_stream() {
        Ok(stream) => {
            let stream_ref: &'static rodio::OutputStream = Box::leak(Box::new(stream));
            if AUDIO_OUTPUT.set(stream_ref).is_err() {
                error!("[player] AUDIO_OUTPUT already set, keeping first instance");
            }
            let sink = Arc::new(Sink::connect_new(stream_ref.mixer()));
            state.sink = Some(sink);
            state.is_initialized = true;
            info!("[player] initialized in {:?}", t0.elapsed());
        }
        Err(e) => {
            error!("[player] failed to open audio output: {e}");
        }
    }
    drop(state);
}

pub async fn cmd_play(file_id: String, position: Option<f64>, ext: Option<String>, fallback_duration: Option<f64>) -> Result<(), String> {
    let t_start = Instant::now();
    info!("[player] cmd_play START file_id={} position={:?} ext={:?} fallback_dur={:?}", file_id, position, ext, fallback_duration);

    let gen = PLAY_GENERATION.fetch_add(1, Ordering::Release) + 1;

    {
        let state = PLAYER.lock().unwrap();
        if !state.is_initialized {
            return Err("player not initialized".into());
        }
    }

    {
        let mut state = PLAYER.lock().unwrap();
        state.current_file_id = Some(file_id.clone());
        state.duration = fallback_duration.unwrap_or(0.0);
        state.ext = ext.clone();
        if let Some(ref sink) = state.sink {
            sink.stop();
            sink.clear();
        }
    }

    let api_url = format!(
        "https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&acknowledgeAbuse=true"
    );

    let token = crate::GLOBAL_STREAM_TOKEN.lock().await.clone();
    if token.is_empty() {
        return Err("no auth token".into());
    }

    let seek_pos = position.unwrap_or(0.0);

    let (final_url, total_size, is_signed) = tokio::task::spawn_blocking({
        let token = token.clone();
        let api_url = api_url.clone();
        move || {
            let resp = NO_REDIRECT_CLIENT
                .get(&api_url)
                .bearer_auth(&token)
                .send()
                .map_err(|e| format!("drive api: {e}"))?;

            let total_size = resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.rsplit('/').next())
                .and_then(|s| s.parse::<u64>().ok())
                .or_else(|| {
                    resp.headers()
                        .get(reqwest::header::CONTENT_LENGTH)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                })
                .ok_or("failed to get file size")?;

            let final_url = if resp.status().is_redirection() {
                resp.headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok().map(String::from))
                    .ok_or("no location header")?
            } else {
                api_url
            };

            let is_signed = !final_url.contains("googleapis.com") && final_url.starts_with("http");
            Ok::<_, String>((final_url, total_size, is_signed))
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    if PLAY_GENERATION.load(Ordering::Acquire) != gen {
        info!("[player] stale generation {}, discarding", gen);
        return Ok(());
    }

    let probe_url = final_url.clone();
    let probe_token = if is_signed { None } else { Some(token.clone()) };

    let estimated_duration = fallback_duration
        .filter(|&d| d > 0.0)
        .unwrap_or_else(|| estimate_duration_from_size(total_size, ext.as_deref()));

    let bitrate_bytes_per_sec = if estimated_duration > 0.0 {
        (total_size as f64 / estimated_duration) as u64
    } else {
        256 * 1024 / 10
    };
    
    // 30 seconds buffer, bounded between 1MB and 30MB
    let max_prefetch = (bitrate_bytes_per_sec * 30).max(1024 * 1024).min(30 * 1024 * 1024);

    let reader: StreamingReader = if is_signed {
        StreamingReader::new(final_url.clone(), total_size, max_prefetch)
    } else {
        StreamingReader::new_with_token(final_url.clone(), total_size, token.clone(), max_prefetch)
    };

    let reader_arc = Arc::new(Mutex::new(reader));

    let (decoder, duration_secs) = {
        let reader_arc = reader_arc.clone();
        let ext = ext.clone();
        let fallback_duration = fallback_duration.clone();
        let probe_url = probe_url.clone();
        let probe_token = probe_token.clone();
        tokio::task::spawn_blocking(move || {

            let shared = SharedReader(reader_arc.clone());

            let mut builder = Decoder::builder()
                .with_data(shared)
                .with_byte_len(total_size)
                .with_seekable(true)
                .with_coarse_seek(true);
            if let Some(ref ext) = ext {
                builder = builder.with_hint(ext);
            }
            let probe_dur = probe_duration_from_stream(&probe_url, &probe_token, total_size);

            let decoder = builder.build().map_err(|e| format!("decoder: {e}"))?;

            let decoder_dur = decoder.total_duration().map(|d| d.as_secs_f64()).filter(|&d| d > 0.0);
            let dur = if seek_pos > 0.0 {
                fallback_duration
                    .filter(|&d| d > 0.0)
                    .or(probe_dur)
                    .or(decoder_dur)
                    .unwrap_or_else(|| estimate_duration_from_size(total_size, ext.as_deref()))
            } else {
                probe_dur
                    .or(decoder_dur)
                    .unwrap_or_else(|| estimate_duration_from_size(total_size, ext.as_deref()))
            };
            Ok::<_, String>((decoder, dur))
        })
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))??
    };

    if PLAY_GENERATION.load(Ordering::Acquire) != gen {
        info!("[player] stale generation {}, discarding", gen);
        return Ok(());
    }

    if duration_secs > 0.0 {
        let mut st = PLAYER.lock().unwrap();
        st.duration = duration_secs;
    }

    let target_volume_arc = {
        let st = PLAYER.lock().unwrap();
        st.target_volume_arc.clone()
    };

    {
        let mut st = PLAYER.lock().unwrap();
        if let Some(ref sink) = st.sink {
            sink.stop();
            sink.clear();
            
            // The rodio Sink volume must always be 1.0. 
            // We use our FadeableSource for true per-sample volume control.
            sink.set_volume(1.0); 
            sink.pause();
            
            // Set initial volume to 0 before creating FadeableSource
            let user_vol = f32::from_bits(target_volume_arc.load(Ordering::Relaxed));
            target_volume_arc.store(0f32.to_bits(), Ordering::Relaxed);
            
            let fade_src = FadeableSource::new(decoder, target_volume_arc.clone());
            sink.append(fade_src);
            
            if seek_pos > 0.0 {
                if let Err(e) = sink.try_seek(std::time::Duration::from_secs_f64(seek_pos)) {
                    warn!("[player] initial seek failed: {}", e);
                }
            }
            sink.play();

            // Tell FadeableSource to fade back to the user's volume
            target_volume_arc.store(user_vol.to_bits(), Ordering::Relaxed);
        }
        st.reader_handle = Some(reader_arc);
    }

    info!("[player] cmd_play COMPLETE in {:?}", t_start.elapsed());
    Ok(())
}

pub fn cmd_pause() -> Result<(), String> {
    let state = PLAYER.lock().unwrap();
    if let Some(ref sink) = state.sink {
        sink.pause();
    }
    Ok(())
}

pub fn cmd_resume() -> Result<(), String> {
    let state = PLAYER.lock().unwrap();
    if let Some(ref sink) = state.sink {
        sink.play();
    }
    Ok(())
}

pub async fn cmd_seek(position: f64) -> Result<(), String> {
    let t_start = Instant::now();
    let position = position.max(0.0);
    info!("[player] cmd_seek START pos={:.1}s", position);

    {
        let state = PLAYER.lock().unwrap();
        if state.is_seeking.load(Ordering::SeqCst) {
            warn!("[player] seek skipped: already seeking");
            return Ok(());
        }
        state.is_seeking.store(true, Ordering::SeqCst);
    }
    let _guard = SeekGuard;

    let (target_vol_arc, sink, last_read_gen) = {
        let state = PLAYER.lock().unwrap();
        if let (Some(ref sink), Some(ref reader)) = (&state.sink, &state.reader_handle) {
            let last_read = reader.lock().unwrap().last_read_gen.clone();
            (state.target_volume_arc.clone(), sink.clone(), last_read)
        } else {
            return Err("no sink playing".to_string());
        }
    };

    // Pre-seek fade-out using FadeableSource
    let prev_target = f32::from_bits(target_vol_arc.load(Ordering::Relaxed));
    target_vol_arc.store(0f32.to_bits(), Ordering::Relaxed);
    
    // Give the audio thread time to hit 0 amplitude (our FadeableSource fades in ~30ms)
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;

    let pre_seek_read_gen = last_read_gen.load(Ordering::Relaxed);
    
    if let Err(e) = sink.try_seek(std::time::Duration::from_secs_f64(position)) {
        warn!("[player] seek failed: {}", e);
    }

    // Wait for the audio thread to process the seek and perform the first read
    // This ensures the buffer is populated BEFORE we fade in!
    let mut waited = 0;
    while last_read_gen.load(Ordering::Relaxed) == pre_seek_read_gen && waited < 1000 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        waited += 10;
    }

    // Post-seek fade-in
    target_vol_arc.store(prev_target.to_bits(), Ordering::Relaxed);

    info!("[player] seek OK in {:?}", t_start.elapsed());
    Ok(())
}

/// Scope guard that resets `is_seeking` to `false` on `Drop`.
/// Prevents leaking `is_seeking=true` when `cmd_seek` exits via error.
/// Re-locks `PLAYER` in `Drop` so the guard lives across await points without
/// borrowing the `MutexGuard` (the old borrow-based `SeekGuard<'a>` could not
/// span the decoder-creation block where `is_seeking` must remain `true`).
struct SeekGuard;
impl Drop for SeekGuard {
    fn drop(&mut self) {
        if let Ok(state) = PLAYER.lock() {
            state.is_seeking.store(false, Ordering::SeqCst);
        }
    }
}

pub fn cmd_set_volume(volume: f64) -> Result<(), String> {
    let state = PLAYER.lock().unwrap();
    state.target_volume_arc.store((volume as f32).to_bits(), Ordering::Relaxed);
    Ok(())
}

pub fn cmd_stop() -> Result<(), String> {
    let mut state = PLAYER.lock().unwrap();
    if let Some(ref sink) = state.sink {
        sink.stop();
        sink.clear();
    }
    state.is_seeking.store(false, Ordering::SeqCst);
    state.reader_handle = None;
    state.current_file_id = None;
    state.duration = 0.0;
    state.ext = None;
    state.final_url = None;
    state.total_size = 0;
    state.use_token = false;
    info!("[player] stopped");
    Ok(())
}

pub fn cmd_get_state() -> Result<serde_json::Value, String> {
    let state = PLAYER.lock().unwrap();
    let is_playing = state
        .sink
        .as_ref()
        .map(|s| !s.is_paused())
        .unwrap_or(false);
    let pos = state
        .sink
        .as_ref()
        .map(|s| s.get_pos().as_secs_f64())
        .unwrap_or(0.0);
    let len = state.sink.as_ref().map(|s| s.len()).unwrap_or(0);
    Ok(serde_json::json!({
        "is_playing": is_playing,
        "position": pos,
        "duration": state.duration,
        "file_id": state.current_file_id,
        "queue_len": len,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test: SeekGuard must reset `is_seeking` even on panic or
    /// normal scope exit. Without this guard, `cmd_seek` leaks `is_seeking`
    /// on error paths, permanently blocking the progress ticker.
    #[test]
    fn seek_guard_resets_is_seeking_on_drop() {
        // Normal exit: set is_seeking=true, create guard, let it drop
        {
            let state = PLAYER.lock().unwrap();
            state.is_seeking.store(true, Ordering::SeqCst);
        }
        {
            let _g = SeekGuard;
            // guard drops here
        }
        let state = PLAYER.lock().unwrap();
        assert!(!state.is_seeking.load(Ordering::SeqCst), "must reset on normal drop");

        // Panic exit
        {
            let state = PLAYER.lock().unwrap();
            state.is_seeking.store(true, Ordering::SeqCst);
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = SeekGuard;
            panic!("simulated failure");
        }));
        let state = PLAYER.lock().unwrap();
        assert!(!state.is_seeking.load(Ordering::SeqCst), "must reset on panic drop");
    }
}
