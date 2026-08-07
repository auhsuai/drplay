// Pure binary sniffing helpers for audio containers. No IO, no dependencies —
// every function is deterministic on its buffer input so the m4a faststart
// decision and AAC short-circuit stay unit-testable.

export type AudioFormat =
  "mp3" | "flac" | "ogg" | "opus" | "m4a" | "wav" | "aac" | "unknown";

// Canonical extension (no leading dot) -> MIME map, mirroring the 7 playable
// formats in audioQuery.PLAYABLE_AUDIO_EXTENSIONS. public/sw.js carries an
// independent copy (the SW cannot import TS); src/utils/swMime.test.ts guards
// the two in sync.
export const AUDIO_EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
};

const FLAC_MAGIC = 0x664c6143; // 'fLaC'
const OGG_MAGIC = 0x4f676753; // 'OggS'
const RIFF_MAGIC = 0x52494646; // 'RIFF'
const OGG_HEADER_LEN = 27;
const OGG_PAGE1_MARKER_SCAN = 96;

// The first Ogg page carries the codec-identification packet right after the
// 27-byte page header + lacing table: 'OpusHead' (opus) or 0x01 'vorbis'
// (vorbis). Anything else that starts with OggS is treated as generic 'ogg'
// and handed to music-metadata for the real parse.
function oggPageOneCodec(b: Uint8Array, oggOffset: number): "opus" | "ogg" {
  const windowEnd = Math.min(b.length, oggOffset + OGG_PAGE1_MARKER_SCAN);
  const start = Math.min(oggOffset + OGG_HEADER_LEN, b.length);
  const window = b.subarray(start, windowEnd);
  for (let i = 0; i + 8 <= window.length; i += 1) {
    if (
      window[i] === 0x4f &&
      window[i + 1] === 0x70 &&
      window[i + 2] === 0x75 &&
      window[i + 3] === 0x73 &&
      window[i + 4] === 0x48 &&
      window[i + 5] === 0x65 &&
      window[i + 6] === 0x61 &&
      window[i + 7] === 0x64
    ) {
      return "opus";
    }
    if (
      window[i] === 0x01 &&
      window[i + 1] === 0x76 &&
      window[i + 2] === 0x6f &&
      window[i + 3] === 0x72 &&
      window[i + 4] === 0x62 &&
      window[i + 5] === 0x69 &&
      window[i + 6] === 0x73
    ) {
      return "ogg";
    }
  }
  return "ogg";
}

function readU32BE(b: Uint8Array, off: number): number {
  return (
    ((b[off] ?? 0) << 24) |
    ((b[off + 1] ?? 0) << 16) |
    ((b[off + 2] ?? 0) << 8) |
    (b[off + 3] ?? 0)
  );
}

function readU64BE(b: Uint8Array, off: number): number {
  const hi = readU32BE(b, off);
  const lo = readU32BE(b, off + 4);
  // The 64-bit size of a top-level mp4 box is only meaningful while it fits
  // the 53-bit safe integer range; anything larger is clamped to 0 so the
  // caller treats it as "extends beyond the buffer" (never loops).
  if (hi > 0x1fffff) return 0;
  return hi * 0x100000000 + lo;
}

function fourCC(b: Uint8Array, off: number, type: string): boolean {
  if (off + 4 > b.length) return false;
  for (let i = 0; i < 4; i += 1) {
    if (b[off + i] !== type.charCodeAt(i)) return false;
  }
  return true;
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
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
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

export interface Mp4BoxWalk {
  moovBeforeMdat: boolean;
  mdatBeforeMoov: boolean;
  moovOffset?: number;
  moovSize?: number;
}

/**
 * Walk the top-level MP4 box chain from the head of the file, reading only
 * the 8-byte (or 16-byte) box headers. Records which of {moov, mdat} appears
 * first and stops safely: a box whose declared size extends beyond the buffer
 * ends the walk instead of looping. "moov before mdat" means the file is
 * faststart — its moov index is already in the head region and the file can
 * be streamed progressively.
 */
export function walkMp4TopBoxes(
  buffer: Uint8Array,
  fileSize: number,
): Mp4BoxWalk {
  const result: Mp4BoxWalk = {
    moovBeforeMdat: false,
    mdatBeforeMoov: false,
  };
  // The walk is bounded by the head buffer; fileSize guards against a
  // degenerate buffer longer than the file it claims to represent.
  const bufSize = Math.min(buffer.length, Math.max(0, fileSize));
  let offset = 0;
  while (offset + 8 <= bufSize) {
    let size = readU32BE(buffer, offset);
    if (size === 1) {
      // 64-bit extended size: a second 8-byte size follows the header.
      if (offset + 16 > bufSize) break;
      size = readU64BE(buffer, offset + 8);
    }
    if (fourCC(buffer, offset + 4, "moov")) {
      result.moovBeforeMdat = true;
      result.moovOffset = offset;
      result.moovSize = size;
      break;
    }
    if (fourCC(buffer, offset + 4, "mdat")) {
      result.mdatBeforeMoov = true;
    }
    // size 0 extends to EOF; size < 8 is malformed; a size beyond the buffer
    // means the box continues past the head — stop walking either way.
    if (size < 8 || offset + size > bufSize) break;
    offset += size;
  }
  return result;
}

export interface MoovTailScan {
  moovOffset: number;
  moovSize: number;
}

// Cap the scan so a pathological tail (e.g. a huge file whose tail is all
// binary noise) cannot burn unbounded CPU: 1MB tail / 4-byte stride.
const TAIL_SCAN_MAX_PROBES = 262_144;

/**
 * Search the tail of an MP4 file for a 'moov' box header at 4-byte aligned
 * offsets. Scans backwards from the end of the file so the REAL moov (the one
 * nearest EOF) wins over stale 'moov' byte patterns inside mdat payloads.
 * @param tailBuffer The last TAIL_BYTES of the file.
 * @param fileSize Total file size (needed to compute absolute offsets and
 * validate that the declared box size fits inside the file).
 * @returns The first valid moov box header, or null when none exists.
 */
export function scanTailForMoov(
  tailBuffer: Uint8Array,
  fileSize: number,
): MoovTailScan | null {
  const tailStart = fileSize - tailBuffer.length;
  const lastProbe = Math.max(0, tailBuffer.length - 8);
  const maxI = Math.min(lastProbe, TAIL_SCAN_MAX_PROBES * 4);
  for (let i = maxI; i >= 0; i -= 4) {
    if (!fourCC(tailBuffer, i + 4, "moov")) continue;
    const absOffset = tailStart + i;
    let size = readU32BE(tailBuffer, i);
    if (size === 1) {
      if (i + 16 > tailBuffer.length) continue;
      size = readU64BE(tailBuffer, i + 8);
    }
    // size 0 = box extends to EOF (valid); otherwise the declared size must
    // fit inside the file or the header is a false positive.
    if (size === 0 || (size >= 8 && absOffset + size <= fileSize)) {
      return { moovOffset: absOffset, moovSize: size };
    }
  }
  return null;
}
