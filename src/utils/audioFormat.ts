// Pure binary sniffing helpers for audio containers. No IO, no dependencies —
// every function is deterministic on its buffer input so the m4a faststart
// decision and AAC short-circuit stay unit-testable.

export type AudioFormat =
  "mp3" | "flac" | "ogg" | "opus" | "m4a" | "wav" | "aac" | "unknown";

// Canonical extension (no leading dot) -> MIME map, mirroring the 7 playable
// formats in audioQuery.PLAYABLE_AUDIO_EXTENSIONS. public/sw.js carries an
// independent copy (the SW cannot import TS); src/utils/swMime.test.ts guards
// the two in sync.
export const AUDIO_EXTENSION_TO_MIME = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
} as const satisfies Record<string, string>;

const FLAC_MAGIC = 0x664c6143; // 'fLaC'
const OGG_MAGIC = 0x4f676753; // 'OggS'
const RIFF_MAGIC = 0x52494646; // 'RIFF'
const OGG_HEADER_LEN = 27;
const OGG_PAGE1_MARKER_SCAN = 96;

function matchesAscii(b: Uint8Array, off: number, str: string): boolean {
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

export const ID3V2_HEADER_LEN = 10;

/**
 * ID3v2 syncsafe tag-body size from the 10-byte header, or 0 when the buffer
 * is too short / not an ID3v2 header. Syncsafe = 4 bytes with MSB 0 each
 * (28-bit value), bytes 6-9 (id3.org/id3v2.3.0#ID3v2_header).
 */
export function readId3v2TagSize(head: Uint8Array): number {
  if (head.length < ID3V2_HEADER_LEN) return 0;
  if (!matchesAscii(head, 0, "ID3")) return 0;
  const b6 = head[6] ?? 0;
  const b7 = head[7] ?? 0;
  const b8 = head[8] ?? 0;
  const b9 = head[9] ?? 0;
  return (
    ((b6 & 0x7f) << 21) | ((b7 & 0x7f) << 14) | ((b8 & 0x7f) << 7) | (b9 & 0x7f)
  );
}

/**
 * Offset of the first MPEG frame sync (0xFF + 3 MSB set) at or after `from`,
 * or -1. music-metadata positions Xing/Info right after the frame header +
 * side info, so this anchors the embedded-duration-tag scan.
 */
export function findMpegFrameSync(head: Uint8Array, from: number): number {
  for (let i = from; i + 1 < head.length; i += 1) {
    if (head[i] === 0xff && ((head[i + 1] ?? 0) & 0xe0) === 0xe0) return i;
  }
  return -1;
}

/**
 * Offset of the first MPEG frame sync after the ID3v2 tag (if any), or -1
 * when the head carries no ID3v2 tag and no sync is found. Deduplicates the
 * tagEnd dance that the CBR probe, the size-derived duration, and the
 * metadata pipeline each copied.
 */
export function findMpegDataStart(head: Uint8Array): number {
  const tagSize = readId3v2TagSize(head);
  const tagEnd =
    tagSize > 0 ? Math.min(head.length, tagSize + ID3V2_HEADER_LEN) : 0;
  return findMpegFrameSync(head, tagEnd);
}

// ---- MPEG audio (MP3) frame-header sniffing ---------------------------------
// verified against music-metadata 11.14.0 (node_modules) — re-verify on
// upgrade. ISO/IEC 11172-3 frame-header tables, mirroring music-metadata's
// MpegFrameHeader (node_modules/music-metadata/lib/mpeg/MpegParser.js). Used
// to prove a constant-bitrate MP3 stream from the head bytes alone, so a
// large CBR file can be parsed at its real size: the parser quits after the
// 4th frame and derives the exact duration from the file size — no stream
// scan, no tail fetch.

/** MPEG audio frame syncword: 0xFFE (11 set bits across the first 2 bytes). */
const MPEG_SYNC_MASK = 0xe0;
/** Frames music-metadata needs before it classifies a stream as CBR. */
const CBR_PROBE_FRAMES = 4;
// Frame-header bit fields (ISO/IEC 11172-3 §2.4.1.3), byte-relative bit
// offsets counted from the MSB of each header byte.
const VERSION_INDEX_SHIFT = 3; // byte 1, 2 bits
const LAYER_INDEX_SHIFT = 1; // byte 1, 2 bits
const BITRATE_INDEX_SHIFT = 4; // byte 2, 4 bits
const SAMPLE_RATE_INDEX_SHIFT = 2; // byte 2, 2 bits
const PADDING_BIT_SHIFT = 1; // byte 2, 1 bit
const TWO_BIT_MASK = 0x03;
const FOUR_BIT_MASK = 0x0f;

// Version index (bits) -> MPEG version; index 1 is reserved (invalid).
const MPEG_VERSION_FROM_INDEX: ReadonlyArray<number | null> = [2.5, null, 2, 1];
// Layer index (bits) -> layer number; index 0 is reserved (ADTS framing).
const MPEG_LAYER_FROM_INDEX: ReadonlyArray<number> = [0, 3, 2, 1];

// Bitrate (kbps) per bitrate index (1..14) and codec key
// 10*floor(version)+layer — the same layout as music-metadata's
// bitrate_index table. Index 0 (free format) and 15 (reserved) are invalid.
const MPEG_BITRATE_KBPS: Readonly<Record<number, ReadonlyArray<number>>> = {
  11: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // MPEG1 Layer1
  12: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // MPEG1 Layer2
  13: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1 Layer3
  21: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // MPEG2(.5) Layer1
  22: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2(.5) Layer2
  23: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2(.5) Layer3
};

// Sample rate (Hz) per version and sample-rate index (0..2; 3 reserved).
const MPEG_SAMPLE_RATES: Readonly<Record<number, ReadonlyArray<number>>> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

// Samples per frame per version and layer (music-metadata
// samplesInFrameTable): MPEG1 [-,384,1152,1152], MPEG2(.5) [-,384,1152,576].
const MPEG_SAMPLES_PER_FRAME: Readonly<Record<number, ReadonlyArray<number>>> =
  {
    1: [0, 384, 1152, 1152],
    2: [0, 384, 1152, 576],
    2.5: [0, 384, 1152, 576],
  };

// Slot size (bytes) per layer: Layer1 frames are 4-byte-aligned units.
const MPEG_SLOT_SIZE: ReadonlyArray<number> = [0, 4, 1, 1];

interface MpegFrameInfo {
  /** Bitrate in bit/s. */
  bitrateBps: number;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Samples decoded per frame (1152 MPEG1 L3, 576 MPEG2(.5) L3). */
  samplesPerFrame: number;
  /** Exact frame length in bytes, including the 4-byte header. */
  frameSize: number;
}

/**
 * Parse one MPEG audio frame header at `offset`. Returns null on any invalid
 * header (bad sync, reserved version/layer, free/reserved bitrate index,
 * reserved sample-rate index, or a header that does not fit the buffer).
 */
function parseMpegFrameHeader(
  head: Uint8Array,
  offset: number,
): MpegFrameInfo | null {
  if (offset + 4 > head.length) return null;
  if (head[offset] !== 0xff) return null;
  const b1 = head[offset + 1] ?? 0;
  if ((b1 & MPEG_SYNC_MASK) !== MPEG_SYNC_MASK) return null;
  const version =
    MPEG_VERSION_FROM_INDEX[(b1 >> VERSION_INDEX_SHIFT) & TWO_BIT_MASK];
  if (version === null || version === undefined) return null;
  const layer = MPEG_LAYER_FROM_INDEX[(b1 >> LAYER_INDEX_SHIFT) & TWO_BIT_MASK];
  if (layer === undefined || layer === 0) return null;
  const b2 = head[offset + 2] ?? 0;
  const bitrateIndex = (b2 >> BITRATE_INDEX_SHIFT) & FOUR_BIT_MASK;
  const bitrateKbps =
    MPEG_BITRATE_KBPS[10 * Math.floor(version) + layer]?.[bitrateIndex - 1];
  if (bitrateKbps === undefined || bitrateKbps === 0) return null;
  const sampleRateIndex = (b2 >> SAMPLE_RATE_INDEX_SHIFT) & TWO_BIT_MASK;
  const sampleRate = MPEG_SAMPLE_RATES[version]?.[sampleRateIndex];
  if (sampleRate === undefined || sampleRate === 0) return null;
  const samplesPerFrame = MPEG_SAMPLES_PER_FRAME[version]?.[layer];
  if (samplesPerFrame === undefined || samplesPerFrame === 0) return null;
  const padding = (b2 >> PADDING_BIT_SHIFT) & 0x01;
  const slotSize = MPEG_SLOT_SIZE[layer] ?? 1;
  // music-metadata frame_size: floor(bps * bitrate / sampleRate) + padding.
  const frameSize = Math.floor(
    (samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate) +
      padding * slotSize,
  );
  return {
    bitrateBps: bitrateKbps * 1000,
    sampleRate,
    samplesPerFrame,
    frameSize,
  };
}

/**
 * Walk CBR_PROBE_FRAMES consecutive frames from the first sync after the
 * ID3v2 tag. Returns the per-frame info when every frame is valid AND all
 * frames share one bitrate and sample rate (constant-bitrate stream), or
 * null otherwise.
 */
function probeMpegCbrFrames(
  head: Uint8Array,
  format: AudioFormat,
): MpegFrameInfo[] | null {
  if (format !== "mp3") return null;
  const frameStart = findMpegDataStart(head);
  if (frameStart < 0) return null;
  const first = parseMpegFrameHeader(head, frameStart);
  if (first === null) return null;
  const frames = [first];
  let offset = frameStart + first.frameSize;
  for (let i = 1; i < CBR_PROBE_FRAMES; i += 1) {
    const info = parseMpegFrameHeader(head, offset);
    if (info === null) return null;
    if (
      info.bitrateBps !== first.bitrateBps ||
      info.sampleRate !== first.sampleRate
    ) {
      return null;
    }
    frames.push(info);
    offset += info.frameSize;
  }
  return frames;
}

/**
 * True when the head carries at least CBR_PROBE_FRAMES consecutive, valid
 * MPEG audio frames at the same bitrate and sample rate — a constant-bitrate
 * stream. music-metadata classifies a stream as CBR at its 4th frame (all
 * bitrates equal) and then derives the duration from the tokenizer's file
 * size instead of scanning the stream; proving CBR from the head lets the
 * caller grant a large file its real size safely.
 * Test-only surface: no production callers — exported solely for the CBR
 * spec-guard in audioFormat.test.ts.
 */
export function isMpegCbr(head: Uint8Array, format: AudioFormat): boolean {
  return probeMpegCbrFrames(head, format) !== null;
}

/**
 * Exact duration (seconds) of a constant-bitrate MP3 computed from the REAL
 * file size — mirrors music-metadata's finalize() CBR path:
 * round((size - mpegOffset) / frameSize) * samplesPerFrame / sampleRate,
 * using the LAST probed frame's size (the frame the parser stops on). Returns
 * null when the head does not prove a CBR stream.
 */
export function mpegCbrDurationFromSize(
  head: Uint8Array,
  format: AudioFormat,
  fileSize: number,
): number | null {
  const frames = probeMpegCbrFrames(head, format);
  if (frames === null || frames.length === 0) return null;
  const mpegOffset = findMpegDataStart(head);
  if (mpegOffset < 0) return null;
  const last = frames[frames.length - 1];
  if (last === undefined) return null;
  const numberOfSamples =
    Math.round((fileSize - mpegOffset) / last.frameSize) * last.samplesPerFrame;
  return numberOfSamples / last.sampleRate;
}

/**
 * Read an MP4 box header at `off`: 8 bytes (32-bit size + 4-char type), or
 * 16 bytes when the size is 1 (64-bit extended size, ISO/IEC 14496-12 §4.2).
 * Returns null when the header does not fit within `bound` — the caller
 * decides how to react (walkMp4TopBoxes stops the walk, scanTailForMoov
 * skips the offset).
 */
function readBoxHeader(
  buffer: Uint8Array,
  off: number,
  bound: number,
): { size: number; type: string } | null {
  if (off + 8 > bound) return null;
  let size = readU32BE(buffer, off);
  if (size === 1) {
    // 64-bit extended size: a second 8-byte size follows the header.
    if (off + 16 > bound) return null;
    size = readU64BE(buffer, off + 8);
  }
  const type = String.fromCharCode(
    buffer[off + 4] ?? 0,
    buffer[off + 5] ?? 0,
    buffer[off + 6] ?? 0,
    buffer[off + 7] ?? 0,
  );
  return { size, type };
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
    const header = readBoxHeader(buffer, offset, bufSize);
    if (header === null) break;
    const { size, type } = header;
    if (type === "moov") {
      result.moovBeforeMdat = true;
      result.moovOffset = offset;
      result.moovSize = size;
      break;
    }
    if (type === "mdat") {
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
    const header = readBoxHeader(tailBuffer, i, tailBuffer.length);
    if (header === null) continue;
    const { size } = header;
    // size 0 = box extends to EOF (valid); otherwise the declared size must
    // fit inside the file or the header is a false positive.
    if (size === 0 || (size >= 8 && absOffset + size <= fileSize)) {
      return { moovOffset: absOffset, moovSize: size };
    }
  }
  return null;
}
