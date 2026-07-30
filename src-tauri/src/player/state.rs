use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use rodio::{OutputStream, Sink};

use crate::player::stream_reader::StreamingReader;

pub static PLAY_GENERATION: AtomicU64 = AtomicU64::new(0);
pub static AUDIO_OUTPUT: OnceLock<&'static OutputStream> = OnceLock::new();

pub struct PlayerState {
    pub sink: Option<Arc<Sink>>,
    pub reader_handle: Option<Arc<Mutex<StreamingReader>>>,
    pub current_file_id: Option<String>,
    pub duration: f64,
    pub ext: Option<String>,
    pub is_initialized: bool,
    pub is_seeking: AtomicBool,
    pub final_url: Option<String>,
    pub total_size: u64,
    pub use_token: bool,
    pub target_volume_arc: Arc<AtomicU32>,
}

impl PlayerState {
    pub fn new() -> Self {
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
            target_volume_arc: Arc::new(AtomicU32::new(1f32.to_bits())),
        }
    }
}

pub static PLAYER: LazyLock<Mutex<PlayerState>> = LazyLock::new(|| Mutex::new(PlayerState::new()));
