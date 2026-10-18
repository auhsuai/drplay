import { matchesAscii, type AudioFormat } from "./detect";

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
