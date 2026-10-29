export type AudioFormat =
  "mp3" | "flac" | "ogg" | "opus" | "m4a" | "wav" | "aac" | "unknown";

// Canonical extension (no leading dot) -> MIME map, mirroring every entry in
// audioQuery.PLAYABLE_AUDIO_EXTENSIONS. public/sw.js carries an independent
// copy (the SW cannot import TS); src/utils/swMime.test.ts guards the two in
// sync. The container is not a codec promise: .m4a can hold AAC or ALAC,
// .ogg/.oga can hold Vorbis or Opus, and .wma covers every WMA variant.
export const AUDIO_EXTENSION_TO_MIME = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
  wma: "audio/x-ms-wma",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  oga: "audio/ogg",
  m4b: "audio/mp4",
  ape: "audio/x-ape",
  wv: "audio/x-wavpack",
  tak: "audio/x-tak",
  dsf: "audio/x-dsf",
  dff: "audio/x-dff",
} as const satisfies Record<string, string>;

const FLAC_MAGIC = 0x664c6143; // 'fLaC'
const OGG_MAGIC = 0x4f676753; // 'OggS'
const RIFF_MAGIC = 0x52494646; // 'RIFF'
const OGG_HEADER_LEN = 27;
const OGG_PAGE1_MARKER_SCAN = 96;

export function matchesAscii(b: Uint8Array, off: number, str: string): boolean {
  if (off < 0 || off + str.length > b.length) return false;
  for (let i = 0; i < str.length; i += 1) {
    if (b[off + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

// The first Ogg page carries the codec-identification packet right after the
// 27-byte page header + lacing table: 'OpusHead' (opus) or 0x01 'vorbis'
// (vorbis). Anything else that starts with OggS is treated as generic 'ogg'
// and handed to music-metadata for the real parse.
function oggPageOneCodec(b: Uint8Array, oggOffset: number): "opus" | "ogg" {
  const windowEnd = Math.min(b.length, oggOffset + OGG_PAGE1_MARKER_SCAN);
  const start = Math.min(oggOffset + OGG_HEADER_LEN, b.length);
  const window = b.subarray(start, windowEnd);
  for (let i = 0; i + 8 <= window.length; i += 1) {
    if (matchesAscii(window, i, "OpusHead")) return "opus";
    if (window[i] === 0x01 && matchesAscii(window, i + 1, "vorbis"))
      return "ogg";
  }
  return "ogg";
}

export function readU32BE(b: Uint8Array, off: number): number {
  return (
    ((b[off] ?? 0) << 24) |
    ((b[off + 1] ?? 0) << 16) |
    ((b[off + 2] ?? 0) << 8) |
    (b[off + 3] ?? 0)
  );
}

export function readU64BE(b: Uint8Array, off: number): number {
  const hi = readU32BE(b, off);
  const lo = readU32BE(b, off + 4);
  // The 64-bit size of a top-level mp4 box is only meaningful while it fits
  // the 53-bit safe integer range; anything larger is clamped to 0 so the
  // caller treats it as "extends beyond the buffer" (never loops).
  if (hi > 0x1fffff) return 0;
  return hi * 0x100000000 + lo;
}

export function fourCC(b: Uint8Array, off: number, type: string): boolean {
  return matchesAscii(b, off, type);
}

/**
 * Detect the audio container from the first bytes of the file. Magic bytes
 * only — the full parse (tags, duration) is delegated to music-metadata.
 * @param head First bytes of the file (at least a few bytes; detection
 * degrades gracefully on truncated buffers).
 * @param _fileName Reserved for extension-based tiebreaking (OggS with no
 * identifiable codec marker); currently only .opus influences the result.
 */
export function detectFormat(head: Uint8Array, fileName?: string): AudioFormat {
  if (head.length < 4) return "unknown";
  const u32 = readU32BE(head, 0);
  // 'ID3' is a 3-byte marker (the 4th byte is the tag version) — compare bytes.
  if (matchesAscii(head, 0, "ID3")) {
    return "mp3";
  }
  if (u32 === FLAC_MAGIC) return "flac";
  if (u32 === OGG_MAGIC) {
    const codec = oggPageOneCodec(head, 0);
    // Generic OggS with no identifiable codec marker: fall back to the
    // extension so .opus files never land in the generic 'ogg' bucket.
    if (codec === "ogg" && fileName?.toLowerCase().endsWith(".opus")) {
      return "opus";
    }
    return codec;
  }
  if (fourCC(head, 4, "ftyp")) return "m4a";
  if (u32 === RIFF_MAGIC && fourCC(head, 8, "WAVE")) return "wav";
  // ADTS (AAC in ADTS framing): syncword 0xFFF with layer bits 00. An MPEG
  // frame header also starts 0xFF, but its layer bits are never 00 (00 is
  // reserved there), so the two never collide.
  const second = head[1] ?? 0;
  if (head[0] === 0xff && (second & 0xf0) === 0xf0 && (second & 0x06) === 0) {
    return "aac";
  }
  return "unknown";
}
