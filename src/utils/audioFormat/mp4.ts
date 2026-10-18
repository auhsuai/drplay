import { fourCC, readU32BE, readU64BE } from "./detect";

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
// binary noise) cannot burn unbounded CPU: at most 1MiB of the tail is
// probed, byte-wise (box offsets are arbitrary — see scanTailForMoov).
const TAIL_SCAN_MAX_BYTES = 1_048_576;

/**
 * Search the tail of an MP4 file for a 'moov' box header, byte-wise. Box
 * offsets are NOT 4-byte aligned: an ISO-BMFF box header is preceded by a
 * box of arbitrary (payload-determined) size, so an aligned stride misses
 * real moov headers (the box is only 8 bytes before its payload, which can
 * start anywhere). Scans backwards from the end of the file so the REAL moov
 * (the one nearest EOF) wins over stale 'moov' byte patterns inside mdat
 * payloads.
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
  const maxI = Math.min(lastProbe, TAIL_SCAN_MAX_BYTES);
  for (let i = maxI; i >= 0; i -= 1) {
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
