pub mod stream_reader;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{error, info, warn};
use rodio::{Decoder, OutputStreamBuilder, Sink, Source};
use tauri::Emitter;

use self::stream_reader::StreamingReader;

const PROGRESS_INTERVAL_MS: u64 = 250;
static PLAY_GENERATION: AtomicU64 = AtomicU64::new(0);
static AUDIO_OUTPUT: OnceLock<&'static rodio::OutputStream> = OnceLock::new();

struct PlayerState {
    sink: Option<Arc<Sink>>,
    current_file_id: Option<String>,
    duration: f64,
    ext: Option<String>,
    is_initialized: bool,
    is_seeking: AtomicBool,
}

impl PlayerState {
    fn new() -> Self {
        Self {
            sink: None,
            current_file_id: None,
            duration: 0.0,
            ext: None,
            is_initialized: false,
            is_seeking: AtomicBool::new(false),
        }
    }
}

static PLAYER: LazyLock<Mutex<PlayerState>> = LazyLock::new(|| Mutex::new(PlayerState::new()));

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
        let state = PLAYER.lock().map_err(|e| e.to_string())?;
        if !state.is_initialized {
            return Err("player not initialized".into());
        }
    }

    {
        let mut state = PLAYER.lock().map_err(|e| e.to_string())?;
        state.current_file_id = Some(file_id.clone());
        state.duration = fallback_duration.unwrap_or(0.0);
        state.ext = ext.clone();
        state.sink = None;
    }

    let api_url = format!(
        "https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&acknowledgeAbuse=true"
    );

    let token = crate::GLOBAL_STREAM_TOKEN.lock().await.clone();
    if token.is_empty() {
        return Err("no auth token".into());
    }

    let (decoder, duration_secs) = tokio::task::spawn_blocking(move || {
        let no_redirect = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("client build: {e}"))?;

        let resp = no_redirect
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

        let reader: StreamingReader = if is_signed {
            StreamingReader::new(final_url, total_size)
        } else {
            StreamingReader::new_with_token(final_url, total_size, token)
        };

        let mut builder = Decoder::builder()
            .with_data(reader)
            .with_byte_len(total_size)
            .with_seekable(true);
        if let Some(ref ext) = ext {
            builder = builder.with_hint(ext);
        }
        let decoder = builder.build().map_err(|e| format!("decoder: {e}"))?;

        let dur = decoder.total_duration().map(|d| d.as_secs_f64()).unwrap_or(0.0);
        Ok::<_, String>((decoder, dur))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))??;

    if PLAY_GENERATION.load(Ordering::Acquire) != gen {
        info!("[player] stale generation {}, discarding", gen);
        return Ok(());
    }

    let stream = AUDIO_OUTPUT.get().ok_or("audio output not available")?;
    let new_sink = Arc::new(Sink::connect_new(stream.mixer()));
    new_sink.append(decoder);

    if duration_secs > 0.0 {
        let mut st = PLAYER.lock().map_err(|e| e.to_string())?;
        st.duration = duration_secs;
    }

    {
        let mut st = PLAYER.lock().map_err(|e| e.to_string())?;
        st.sink = Some(new_sink.clone());
    }

    if let Some(pos) = position {
        if pos > 0.0 && duration_secs > 0.0 {
            let seek_target = Duration::try_from_secs_f64(pos).unwrap_or_default();
            if let Err(e) = new_sink.try_seek(seek_target) {
                warn!("[player] seek failed ({:?}), playback from start", e);
            }
        }
    }

    new_sink.play();

    info!("[player] cmd_play COMPLETE in {:?}", t_start.elapsed());
    Ok(())
}

pub fn cmd_pause() -> Result<(), String> {
    let state = PLAYER.lock().map_err(|e| e.to_string())?;
    if let Some(ref sink) = state.sink {
        sink.pause();
    }
    Ok(())
}

pub fn cmd_resume() -> Result<(), String> {
    let state = PLAYER.lock().map_err(|e| e.to_string())?;
    if let Some(ref sink) = state.sink {
        sink.play();
    }
    Ok(())
}

pub async fn cmd_seek(position: f64) -> Result<(), String> {
    let t_start = Instant::now();
    let position = position.max(0.0);
    info!("[player] cmd_seek START pos={:.1}s", position);

    let sink = {
        let state = PLAYER.lock().map_err(|e| e.to_string())?;
        if state.is_seeking.load(Ordering::SeqCst) {
            warn!("[player] seek skipped: already seeking");
            return Ok(());
        }
        state.is_seeking.store(true, Ordering::SeqCst);
        state.sink.as_ref().ok_or("no active sink")?.clone()
    };

    let seek_target = Duration::try_from_secs_f64(position).unwrap_or_default();
    let result = sink.try_seek(seek_target);

    {
        let state = PLAYER.lock().map_err(|e| e.to_string())?;
        state.is_seeking.store(false, Ordering::SeqCst);
    }

    match result {
        Ok(()) => info!("[player] seek OK in {:?}", t_start.elapsed()),
        Err(ref e) => error!("[player] seek FAILED: {e:?}"),
    }

    result.map_err(|e| format!("seek failed: {e:?}"))
}

pub fn cmd_set_volume(volume: f64) -> Result<(), String> {
    let state = PLAYER.lock().map_err(|e| e.to_string())?;
    if let Some(ref sink) = state.sink {
        sink.set_volume(volume as f32);
    }
    Ok(())
}

pub fn cmd_stop() -> Result<(), String> {
    let mut state = PLAYER.lock().map_err(|e| e.to_string())?;
    if let Some(ref sink) = state.sink {
        sink.stop();
        sink.clear();
    }
    state.current_file_id = None;
    state.duration = 0.0;
    state.ext = None;
    info!("[player] stopped");
    Ok(())
}

pub fn cmd_get_state() -> Result<serde_json::Value, String> {
    let state = PLAYER.lock().map_err(|e| e.to_string())?;
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

pub fn start_progress_ticker(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(PROGRESS_INTERVAL_MS));
            let state = PLAYER.lock().ok();
            let state = match state {
                Some(s) => s,
                None => continue,
            };
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
            let dur = state.duration;
            let file_id = state.current_file_id.clone();
            drop(state);
            let _ = app_handle.emit(
                "playback_time_update",
                serde_json::json!({
                    "position": pos,
                    "duration": dur,
                    "is_playing": is_playing,
                    "file_id": file_id,
                }),
            );
        }
    });
}
