pub mod stream_reader;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{error, info, warn};
use rodio::{Decoder, OutputStreamBuilder, Sink, Source};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::get_probe;
use std::io::{self, Read, Seek, SeekFrom};
use tauri::Emitter;

use self::stream_reader::{StreamingReader, SharedReader};

static NO_REDIRECT_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("no-redirect blocking client")
});

const PROGRESS_INTERVAL_MS: u64 = 250;
static PLAY_GENERATION: AtomicU64 = AtomicU64::new(0);
static AUDIO_OUTPUT: OnceLock<&'static rodio::OutputStream> = OnceLock::new();

struct PlayerState {
    sink: Option<Arc<Sink>>,
    reader_handle: Option<Arc<Mutex<StreamingReader>>>,
    current_file_id: Option<String>,
    duration: f64,
    ext: Option<String>,
    is_initialized: bool,
    is_seeking: AtomicBool,
    final_url: Option<String>,
    total_size: u64,
    use_token: bool,
    target_volume: f32,
    fade_gen: AtomicU64,
}

impl PlayerState {
    fn new() -> Self {
        Self {
            sink: None,
            reader_handle: None,
            current_file_id: None,
            duration: 0.0,
            ext: None,
            is_initialized: false,
            is_seeking: AtomicBool::new(false),
            final_url: None,
            total_size: 0,
            use_token: false,
            target_volume: 1.0,
            fade_gen: AtomicU64::new(0),
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

struct BufferedHttpReader {
    url: String,
    token: Option<String>,
    total_size: u64,
    pos: u64,
    buf: Vec<u8>,
    buf_start: u64,
}

impl BufferedHttpReader {
    fn new(url: String, token: Option<String>, total_size: u64) -> Self {
        Self {
            url,
            token,
            total_size,
            pos: 0,
            buf: Vec::new(),
            buf_start: 0,
        }
    }

    fn fill_buf(&mut self) -> io::Result<()> {
        let fetch_size = 65536; // 64KB
        let end = (self.pos + fetch_size - 1).min(self.total_size.saturating_sub(1));
        if self.pos > end {
            self.buf.clear();
            return Ok(());
        }
        match stream_reader::fetch_range_raw(&self.url, &self.token, self.pos, end) {
            Ok(data) => {
                self.buf = data;
                self.buf_start = self.pos;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
}

impl Read for BufferedHttpReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.total_size {
            return Ok(0);
        }
        if self.buf.is_empty() || self.pos < self.buf_start || self.pos >= self.buf_start + self.buf.len() as u64 {
            self.fill_buf()?;
        }
        if self.buf.is_empty() {
            return Ok(0);
        }
        let offset = (self.pos - self.buf_start) as usize;
        let available = self.buf.len().saturating_sub(offset);
        let to_copy = available.min(buf.len());
        buf[..to_copy].copy_from_slice(&self.buf[offset..offset + to_copy]);
        self.pos += to_copy as u64;
        Ok(to_copy)
    }
}

impl Seek for BufferedHttpReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let new_pos = match pos {
            SeekFrom::Start(offset) => offset.min(self.total_size),
            SeekFrom::End(offset) => {
                if offset >= 0 {
                    self.total_size
                } else {
                    self.total_size.saturating_sub((-offset) as u64)
                }
            }
            SeekFrom::Current(offset) => {
                if offset >= 0 {
                    self.pos.saturating_add(offset as u64).min(self.total_size)
                } else {
                    self.pos.saturating_sub((-offset) as u64)
                }
            }
        };
        self.pos = new_pos;
        Ok(self.pos)
    }
}

impl MediaSource for BufferedHttpReader {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.total_size)
    }
}

fn probe_duration_from_stream(url: &str, token: &Option<String>, total_size: u64) -> Option<f64> {
    if total_size < 4 {
        return None;
    }

    let mut reader = BufferedHttpReader::new(url.to_string(), token.clone(), total_size);

    let mut initial_data = vec![0u8; 65536.min(total_size as usize)];
    let _ = reader.read_exact(&mut initial_data);
    let _ = reader.seek(SeekFrom::Start(0));

    let hint = Hint::new();
    let mss = MediaSourceStream::new(Box::new(reader), Default::default());
    let format_opts = FormatOptions::default();
    let meta_opts = MetadataOptions::default();

    if let Ok(probed) = get_probe().format(&hint, mss, &format_opts, &meta_opts) {
        let format = probed.format;
        if let Some(track) = format.default_track() {
            if let (Some(n_frames), Some(time_base)) = (track.codec_params.n_frames, track.codec_params.time_base) {
                let dur = time_base.calc_time(n_frames);
                let dur_secs = dur.seconds as f64 + dur.frac as f64;
                if dur_secs > 0.0 {
                    let implied_bps = (total_size as f64 * 8.0) / dur_secs;
                    if implied_bps < 10_000_000.0 {
                        return Some(dur_secs);
                    }
                }
            }
        }

        if let Some(bitrate) = parse_mp3_first_frame_bitrate(&initial_data) {
            if total_size > 0 {
                return Some((total_size as f64 * 8.0) / bitrate as f64);
            }
        }
    }

    if let Some(bitrate) = parse_mp3_first_frame_bitrate(&initial_data) {
        if total_size > 0 {
            return Some((total_size as f64 * 8.0) / bitrate as f64);
        }
    }

    None
}

fn parse_mp3_first_frame_bitrate(data: &[u8]) -> Option<u32> {
    if data.len() < 4 {
        return None;
    }

    let offset = if data.len() >= 10 && data[0] == b'I' && data[1] == b'D' && data[2] == b'3' {
        let size = ((data[6] as u32) << 21)
            | ((data[7] as u32) << 14)
            | ((data[8] as u32) << 7)
            | data[9] as u32;
        (size + 10) as usize
    } else {
        0
    };

    if offset + 4 > data.len() {
        return None;
    }

    let h = &data[offset..offset + 4];

    if h[0] != 0xFF || (h[1] & 0xE0) != 0xE0 {
        return None;
    }

    let layer = (h[1] >> 1) & 0x03;
    let bitrate_index = (h[2] >> 4) & 0x0F;

    if layer != 0x01 || bitrate_index == 0 || bitrate_index == 0x0F {
        return None;
    }

    let is_mpeg1 = ((h[1] >> 3) & 0x03) == 0x03;

    const BITRATES: [[u32; 14]; 2] = [
        [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192],
        [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    ];

    let table_idx = if is_mpeg1 { 1 } else { 0 };
    Some(BITRATES[table_idx][(bitrate_index - 1) as usize] * 1000)
}

fn estimate_duration_from_size(total_size: u64, ext: Option<&str>) -> f64 {
    let bitrate_bps = match ext.and_then(|s| s.split('.').last().or(Some(s))) {
        Some("mp3") => 192_000,
        Some("flac") => 800_000,
        Some("ogg") | Some("vorbis") => 160_000,
        Some("m4a") | Some("aac") | Some("mp4") => 192_000,
        Some("wav") => 1_411_200,
        Some("wma") => 192_000,
        Some("opus") => 96_000,
        _ => 128_000,
    };
    if total_size > 0 {
        (total_size as f64 * 8.0) / bitrate_bps as f64
    } else {
        0.0
    }
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

    let (target_vol, fade_gen) = {
        let st = PLAYER.lock().unwrap();
        let gen = st.fade_gen.fetch_add(1, Ordering::SeqCst) + 1;
        (st.target_volume, gen)
    };

    {
        let mut st = PLAYER.lock().unwrap();
        if let Some(ref sink) = st.sink {
            sink.stop();
            sink.clear();
            sink.set_volume(0.0);
            sink.pause();
            sink.append(decoder);
            if seek_pos > 0.0 {
                if let Err(e) = sink.try_seek(std::time::Duration::from_secs_f64(seek_pos)) {
                    warn!("[player] initial seek failed: {}", e);
                }
            }
            sink.play();

            let sink_clone = sink.clone();
            tokio::spawn(async move {
                for i in 1..=20 {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    let current_gen = PLAYER.lock().unwrap().fade_gen.load(Ordering::SeqCst);
                    if current_gen != fade_gen { return; }
                    sink_clone.set_volume(target_vol * (i as f32 / 20.0));
                }
            });
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

    let (target_vol, fade_gen, sink, last_read_gen) = {
        let state = PLAYER.lock().unwrap();
        if let (Some(ref sink), Some(ref reader)) = (&state.sink, &state.reader_handle) {
            let gen = state.fade_gen.fetch_add(1, Ordering::SeqCst) + 1;
            let last_read = reader.lock().unwrap().last_read_gen.clone();
            (state.target_volume, gen, sink.clone(), last_read)
        } else {
            return Err("no sink playing".to_string());
        }
    };

    // 20ms pre-seek fade-out
    for i in (0..=5).rev() {
        tokio::time::sleep(std::time::Duration::from_millis(4)).await;
        let current_gen = PLAYER.lock().unwrap().fade_gen.load(Ordering::SeqCst);
        if current_gen != fade_gen { return Ok(()); }
        sink.set_volume(target_vol * (i as f32 / 5.0));
    }

    sink.set_volume(0.0);
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

    // 100ms post-seek fade-in
    tokio::spawn(async move {
        for i in 1..=20 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            let current_gen = PLAYER.lock().unwrap().fade_gen.load(Ordering::SeqCst);
            if current_gen != fade_gen { return; }
            sink.set_volume(target_vol * (i as f32 / 20.0));
        }
    });

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
            let mut state = PLAYER.lock().unwrap();
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
            let mut state = PLAYER.lock().unwrap();
            state.is_seeking.store(true, Ordering::SeqCst);
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = SeekGuard;
            panic!("simulated failure");
        }));
        let state = PLAYER.lock().unwrap();
        assert!(!state.is_seeking.load(Ordering::SeqCst), "must reset on panic drop");
    }

    /// Integration-style: verify the current `is_seeking` in PLAYER state
    /// after a seek that must fail (no `final_url` set).
    #[tokio::test]
    async fn cmd_seek_clears_is_seeking_on_error() {
        // Initialize player state with a mock sink
        {
            let mut state = PLAYER.lock().unwrap();
            // Set up minimal state: initialized, has sink (but no final_url)
            // We can't easily create a real Sink without audio output,
            // so this test asserts the guard mechanism is in place.
            // Without the fix, is_seeking would leak to true.
            state.is_seeking.store(false, Ordering::SeqCst);
        }

        // Call cmd_seek — will fail because no final_url is set.
        // Current code leaks is_seeking=true. Fixed code should not.
        let result = cmd_seek(30.0).await;
        assert!(result.is_err(), "seek without URL must fail");

        let state = PLAYER.lock().unwrap();
        assert!(
            !state.is_seeking.load(Ordering::SeqCst),
            "is_seeking must be reset after failed seek"
        );
    }
}

pub fn cmd_set_volume(volume: f64) -> Result<(), String> {
    let mut state = PLAYER.lock().unwrap();
    state.target_volume = volume as f32;
    state.fade_gen.fetch_add(1, Ordering::SeqCst);
    if let Some(ref sink) = state.sink {
        sink.set_volume(volume as f32);
    }
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

pub fn start_progress_ticker(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(PROGRESS_INTERVAL_MS));
            let state = PLAYER.lock().ok();
            let state = match state {
                Some(s) => s,
                None => continue,
            };
            if state.is_seeking.load(Ordering::SeqCst) {
                drop(state);
                continue;
            }
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
