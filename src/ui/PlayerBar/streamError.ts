// Pure, testable decision logic for audio decode failures surfaced by the
// <audio> element.
//
// Root cause context: the proxy used to forward Google Drive's Content-Type
// verbatim (often `application/octet-stream` for FLAC). The WebView cannot pick
// a demuxer for an unknown MIME and rejects the stream with
// MEDIA_ERR_SRC_NOT_SUPPORTED. The old frontend logic treated a successful HEAD
// probe (the proxy serves the file fine) as proof of a "real format error" and
// skipped the track — a false positive for any format the web CAN actually
// decode once served with the correct MIME (the proxy now overrides it via the
// signed `ext` param).
//
// This module encodes the CORRECT decision so a valid FLAC (or mp3/ogg/...) is
// retried with a freshly-signed URL (correct MIME) instead of being skipped.

export const MEDIA_ERR_ABORTED = 1;
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// Host/path the Tauri proxy exposes signed stream URLs under. Kept as named
// constants so the proxy-stream check (used in multiple playback modules) is
// defined exactly once and cannot drift between copies.
export const PROXY_STREAM_HOST = 'drplay.localhost';
export const PROXY_STREAM_PATH = '/stream';

// True when `url` points at our own signed proxy stream. Never throws and never
// logs — callers must not pass secrets here, only the (already-signed) stream URL.
export function isProxyStreamUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === PROXY_STREAM_HOST && u.pathname === PROXY_STREAM_PATH;
  } catch {
    return false;
  }
}

// Formats the web platform (Chromium/WebView2, Safari, Firefox) can natively
// decode. A decode failure on one of these is almost always a transport /
// wrong-Content-Type issue, NOT a corrupt file, so we must retry rather than
// declare a definitive format error.
export const KNOWN_DECODABLE_EXTENSIONS = new Set<string>([
  "mp3",
  "flac",
  "ogg",
  "oga",
  "opus",
  "wav",
  "m4a",
  "aac",
  "mp4",
  "m4v",
  "webm",
  "caf",
  "aiff",
  "aif",
]);

export function isKnownDecodableExt(ext: string | undefined | null): boolean {
  if (!ext) return false;
  return KNOWN_DECODABLE_EXTENSIONS.has(ext.toLowerCase());
}

export interface DecodeFailureDecision {
  /** HEAD probe succeeded yet the WebView still can't decode a KNOWN-decodable
   *  format → almost certainly wrong Content-Type. Retry with a freshly-signed
   *  (correct-MIME) URL instead of skipping. */
  shouldRetryWithCorrectType: boolean;
  /** HEAD probe succeeded and the format is genuinely unsupported → skip. */
  isDefinitiveFormatError: boolean;
}

export function decideDecodeFailure(params: {
  mediaErrorCode: number;
  headOk: boolean;
  ext: string | undefined;
}): DecodeFailureDecision {
  const decodeError =
    params.mediaErrorCode === MEDIA_ERR_SRC_NOT_SUPPORTED ||
    params.mediaErrorCode === MEDIA_ERR_DECODE;

  // Not a decode/unsupported error, or the HEAD probe failed (file problem /
  // transient) → handled by the other branches, never a format error here.
  if (!params.headOk || !decodeError) {
    return { shouldRetryWithCorrectType: false, isDefinitiveFormatError: false };
  }

  if (isKnownDecodableExt(params.ext)) {
    // The format is playable in the WebView. A failure here means the proxy most
    // likely served it with the wrong Content-Type (e.g. application/octet-stream
    // for FLAC). Retry with a fresh URL — the proxy serves the correct MIME now.
    return { shouldRetryWithCorrectType: true, isDefinitiveFormatError: false };
  }

  // HEAD ok + genuinely unsupported format → definitive format error (skip).
  return { shouldRetryWithCorrectType: false, isDefinitiveFormatError: true };
}
