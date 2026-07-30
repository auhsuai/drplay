use std::io::{self, Read, Seek, SeekFrom};

use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::get_probe;

use super::stream_reader;

pub(crate) struct BufferedHttpReader {
    url: String,
    token: Option<String>,
    total_size: u64,
    pos: u64,
    buf: Vec<u8>,
    buf_start: u64,
}

impl BufferedHttpReader {
    pub fn new(url: String, token: Option<String>, total_size: u64) -> Self {
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

pub(crate) fn probe_duration_from_stream(url: &str, token: &Option<String>, total_size: u64) -> Option<f64> {
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

pub(crate) fn parse_mp3_first_frame_bitrate(data: &[u8]) -> Option<u32> {
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

pub(crate) fn estimate_duration_from_size(total_size: u64, ext: Option<&str>) -> f64 {
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
