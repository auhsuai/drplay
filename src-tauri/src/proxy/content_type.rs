/// Map a file extension to its canonical audio MIME type.
///
/// Google Drive frequently returns `application/octet-stream` (or a stale type)
/// for FLAC and other lossless files. The `ext` query param is already part of
/// the signed URL, so when it maps to a known type we OVERRIDE Drive's
/// Content-Type. Without this, the WebView cannot pick a demuxer for an
/// `octet-stream` FLAC stream and rejects it with `MEDIA_ERR_SRC_NOT_SUPPORTED`,
/// causing the frontend to wrongly skip a perfectly playable track as a
/// "format error". Chromium/WebView2 decode FLAC natively when served as
/// `audio/flac` (see MDN: Chrome/Edge FLAC = Yes; chromium.org audio codecs).
pub fn content_type_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "flac" => Some("audio/flac"),
        "ogg" | "oga" => Some("audio/ogg"),
        "opus" => Some("audio/ogg"),
        "wav" => Some("audio/wav"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "mp3" => Some("audio/mpeg"),
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("audio/webm"),
        "caf" => Some("audio/x-caf"),
        "aiff" | "aif" => Some("audio/aiff"),
        _ => None,
    }
}

/// Trim a cached slice to the requested byte window: drop `skip` leading bytes
/// on the very first slice, then truncate to `remaining` bytes at the tail.
/// Used identically on both the cache-hit and batch-send paths.
pub fn trim_cached_slice(chunk: &mut Vec<u8>, skip: usize, remaining: usize) {
    if skip < chunk.len() {
        chunk.drain(..skip);
    }
    if remaining < chunk.len() {
        chunk.truncate(remaining);
    }
}
