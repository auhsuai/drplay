import {
  BUDGET_CAP,
  DriveRangeTokenizer,
  TAIL_BYTES,
} from "../driveRangeTokenizer";
import {
  ID3V2_HEADER_LEN,
  readId3v2TagSize,
  scanTailForMoov,
} from "../audioFormat";
import { classifyMetaError } from "./cache";
import {
  COVER_SLACK_BYTES,
  HEAD_TAG_FETCH_BYTES,
  TAG_BUDGET_MAX,
} from "./constants";
import { logMetaWarn } from "./pipelineHelpers";

// FLAC metadata-block layout (xiph.org/flac/format.html): after the 4-byte
// 'fLaC' marker every block carries a 4-byte header — 1 flag/type byte (top
// bit = last-block flag, low 7 bits = type) + 24-bit big-endian length.
const FLAC_MARKER_LEN = 4;
const FLAC_BLOCK_HEADER_LEN = 4;
const FLAC_BLOCK_TYPE_MASK = 0x7f;
const FLAC_LAST_BLOCK_FLAG = 0x80;
const FLAC_BLOCK_TYPE_PICTURE = 6;

/**
 * End offset (exclusive) of the furthest PICTURE block whose header already
 * sits inside `head`, or 0 when no picture header is visible. Reads ONLY the
 * block headers from the already-fetched head — never the network — so a
 * picture spilling past the blind head still reveals its full extent through
 * its 24-bit length field. A header truncated by the head edge stops the walk
 * (the extent is unknowable without another fetch, and the chunked parse
 * below stays the fallback).
 */
function flacPictureEnd(head: Uint8Array): number {
  if (head.length < FLAC_MARKER_LEN + FLAC_BLOCK_HEADER_LEN) return 0;
  let pictureEnd = 0;
  let offset = FLAC_MARKER_LEN;
  while (offset + FLAC_BLOCK_HEADER_LEN <= head.length) {
    const flagType = head[offset] ?? 0;
    const type = flagType & FLAC_BLOCK_TYPE_MASK;
    const last = (flagType & FLAC_LAST_BLOCK_FLAG) !== 0;
    const len =
      ((head[offset + 1] ?? 0) << 16) |
      ((head[offset + 2] ?? 0) << 8) |
      (head[offset + 3] ?? 0);
    const blockEnd = offset + FLAC_BLOCK_HEADER_LEN + len;
    if (type === FLAC_BLOCK_TYPE_PICTURE && blockEnd > pictureEnd) {
      pictureEnd = blockEnd;
    }
    // A last-marked block ends the chain; a block running past the head edge
    // hides every later header (including any further PICTURE), so stop.
    if (last || blockEnd > head.length) break;
    offset = blockEnd;
  }
  return pictureEnd;
}

async function prepareMp3Tokenizer(
  tokenizer: DriveRangeTokenizer,
  fileId: string,
  size: number,
  head: Uint8Array,
  parseSize: number,
  signal?: AbortSignal,
): Promise<DriveRangeTokenizer> {
  // ID3v2 tags are read WHOLE by music-metadata (one readToken of the tag
  // body) — an unusually large tag (e.g. a 25MB cover) blows the default
  // 20MB fetch budget and nukes the whole entry. Raise the budget for the
  // tag region (capped at TAG_BUDGET_MAX); rare files only. The new
  // tokenizer re-fetches the head region — one extra request, accepted.
  // Large files keep the CLAMPED size here: a tag bigger than HEAD_BYTES
  // fails its parse (placeholder) instead of ever opening a full-size
  // tokenizer (too rare to spend a tail-capable fetch on).
  const tagSize = readId3v2TagSize(head);
  const tagBudgetNeeded = tagSize + ID3V2_HEADER_LEN + COVER_SLACK_BYTES;
  if (tagSize > 0 && tagBudgetNeeded > BUDGET_CAP) {
    tokenizer = new DriveRangeTokenizer(fileId, parseSize, {
      budgetBytes: Math.min(tagBudgetNeeded, TAG_BUDGET_MAX),
      ...(signal ? { abortSignal: signal } : {}),
    });
  }
  // Metadata-load latency: a tag extending past the blind head fetch was
  // read chunk-by-chunk (64KB per request) — a 600KB tag alone cost ~9
  // range requests, a 25MB tag ~400, all queued behind the app-wide
  // CONCURRENCY-3 semaphore. Prefetch ONLY the part past the blind head
  // (which already cached [0, HEAD_TAG_FETCH_BYTES)) so no byte is
  // re-fetched: HEAD_TAG_FETCH_BYTES is 64KB-aligned, so the range starts
  // exactly at the boundary. Best-effort: on budget or network failure
  // the prefetch is skipped and the parse re-reads the region chunked
  // exactly as before (the raised-budget retry / skipCovers fallbacks
  // are untouched). For LARGE files parseSize is clamped to HEAD_BYTES,
  // so prefetchEnd < HEAD_TAG_FETCH_BYTES → this never fires (byte
  // pattern identical to the pre-slice clamp; a tag that cannot fit the
  // clamped head keeps failing its parse into the placeholder — behavior
  // unchanged).
  if (tagSize > 0) {
    const prefetchEnd = Math.min(tagBudgetNeeded, parseSize);
    if (prefetchEnd > HEAD_TAG_FETCH_BYTES) {
      try {
        await tokenizer.prefetchRange(HEAD_TAG_FETCH_BYTES, prefetchEnd);
      } catch (e: unknown) {
        void logMetaWarn(
          `tag-prefetch-failed (fileId=${fileId}, size=${String(size)}): ${classifyMetaError(e).message}`,
        );
      }
    }
  }
  return tokenizer;
}

async function prefetchFlacPictureRemainder(
  tokenizer: DriveRangeTokenizer,
  fileId: string,
  size: number,
  head: Uint8Array,
  parseSize: number,
): Promise<void> {
  // A FLAC cover lives in a PICTURE block AFTER the vorbis comments, so a
  // ~2MB cover spills past the 1.5MB blind head and its remainder was read
  // chunk-by-chunk (64KB per request, ~8 requests queued behind the
  // app-wide CONCURRENCY-3 semaphore). The PICTURE header (with its
  // 24-bit length) sits at a tiny offset inside the head, so the spill
  // extent is known WITHOUT another fetch — prefetch ONLY the part past
  // the blind head (which already cached [0, HEAD_TAG_FETCH_BYTES)), the
  // exact mirror of the MP3 tag-remainder prefetch above. Best-effort: on
  // budget or network failure the parse re-reads the region chunked
  // exactly as before. Clamped to parseSize so large files (whose head is
  // only HEAD_BYTES) never fire this; the per-file budget itself is
  // enforced by prefetchRange's assertBudget (a BudgetExceededError lands
  // in the same warn-and-continue path, keeping the cover-degraded-budget
  // retry for 2x12MB FLACs intact).
  const pictureEnd = Math.min(flacPictureEnd(head), parseSize);
  if (pictureEnd > HEAD_TAG_FETCH_BYTES) {
    try {
      await tokenizer.prefetchRange(HEAD_TAG_FETCH_BYTES, pictureEnd);
    } catch (e: unknown) {
      void logMetaWarn(
        `picture-prefetch-failed (fileId=${fileId}, size=${String(size)}): ${classifyMetaError(e).message}`,
      );
    }
  }
}

async function prefetchAndScanM4aTail(
  tokenizer: DriveRangeTokenizer,
  fileId: string,
  size: number,
): Promise<void> {
  try {
    const tailStart = Math.max(0, size - TAIL_BYTES);
    try {
      // Metadata-load latency: scanning a 1MB tail chunk-by-chunk cost
      // 16 range requests (64KB each) behind the CONCURRENCY-3
      // semaphore. Prefetch the tail in ONE request; the scan below
      // then reads it from the seeded cache.
      await tokenizer.prefetchRange(tailStart, size);
    } catch (e: unknown) {
      // Best-effort optimization only: a failed prefetch must not
      // change the tail scan — readRange below re-reads the region
      // chunked, exactly as before (same scan outcome, more requests).
      void logMetaWarn(
        `m4a-tail-prefetch-failed (fileId=${fileId}, size=${String(size)}): ${classifyMetaError(e).message}`,
      );
    }
    const tail = await tokenizer.readRange(tailStart, size);
    if (scanTailForMoov(tail, size) === null) {
      await logMetaWarn(
        `m4a-tail-scan: no moov box found at the end of file (fileId=${fileId}, size=${String(size)})`,
      );
    }
  } catch (e: unknown) {
    await logMetaWarn(
      `m4a-tail-scan-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
    );
  }
}

export {
  prepareMp3Tokenizer,
  prefetchFlacPictureRemainder,
  prefetchAndScanM4aTail,
};
