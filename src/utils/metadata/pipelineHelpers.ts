import { findMpegDataStart, type AudioFormat } from "../audioFormat";
import { captureError } from "../errorLog";
import { stripAudioExtension } from "../pathUtils";
import {
  CACHE_VERSION,
  DURATION_TAG_SCAN_BYTES,
  META_MODULE,
  UNKNOWN_ARTIST,
  V_PLACEHOLDER,
} from "./constants";
import type { CachedMetadata } from "./types";

export const logMetaWarn = (message: string, kind?: string): Promise<void> =>
  captureError({
    level: "warn",
    source: META_MODULE,
    message,
    ...(kind ? { kind } : {}),
  });

const stripExtension = (name: string): string => stripAudioExtension(name);

// A persisted metadataCache entry that carries REAL parsed metadata (shared
// single source of truth for searchEngine.loadRealMetadata and
// history.getRandomDiscoveries — the two copies used to drift).
export interface RealCacheEntry {
  version: number;
  data: CachedMetadata;
}

// Defensive narrowing of the `unknown` metadataCache entry (db.ts:
// MetadataCacheRow.entry). Malformed rows (non-object, wrong version, missing
// data.v, v >= placeholder) are skipped — never thrown on. NOT the same rule as
// cache.ts isCacheEntry, which MUST keep accepting v:9 placeholders as hits.
export function isRealCacheEntry(entry: unknown): entry is RealCacheEntry {
  if (typeof entry !== "object" || entry === null) return false;
  if (!("version" in entry) || entry.version !== CACHE_VERSION) return false;
  if (!("data" in entry)) return false;
  const data = entry.data;
  if (typeof data !== "object" || data === null) return false;
  if (!("v" in data) || typeof data.v !== "number") return false;
  // v:9 placeholders (constants.ts V_PLACEHOLDER) are NOT real metadata and
  // must never be indexed/searchable (plan Global Constraints).
  return data.v < V_PLACEHOLDER;
}

/**
 * True when the head carries an embedded duration tag music-metadata actually
 * parses (Xing / Info). Used to gate the duration of a HEAD-CLAMPED parse:
 * without such a tag the parser derives the duration from the clamped file
 * size (CBR) or the EOF frame count (VBR) — both bogus seconds for a
 * truncated view of a large file. Known non-MP3 formats (e.g. a faststart
 * moov at the head) carry real durations in the head and are trusted;
 * "unknown" is NOT — an untagged MP3 also parses as "unknown", and its
 * duration is exactly the size-derived CBR value this gate exists to reject.
 */
function hasEmbeddedDurationTag(
  head: Uint8Array,
  format: AudioFormat,
): boolean {
  if (format !== "mp3" && format !== "unknown") return true;
  const frameStart = findMpegDataStart(head);
  if (frameStart < 0) return false;
  const searchEnd = Math.min(head.length, frameStart + DURATION_TAG_SCAN_BYTES);
  for (let i = frameStart + 4; i + 3 < searchEnd; i += 1) {
    const b0 = head[i] ?? 0;
    const b1 = head[i + 1] ?? 0;
    const b2 = head[i + 2] ?? 0;
    const b3 = head[i + 3] ?? 0;
    if (
      (b0 === 0x58 && b1 === 0x69 && b2 === 0x6e && b3 === 0x67) || // Xing
      (b0 === 0x49 && b1 === 0x6e && b2 === 0x66 && b3 === 0x6f) // Info (CBR)
    ) {
      return true;
    }
  }
  return false;
}

function makePlaceholder(safeName: string, size?: number): CachedMetadata {
  return {
    title: stripExtension(safeName),
    artist: UNKNOWN_ARTIST,
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: V_PLACEHOLDER,
    // The size is set only when the caller knows it: a placeholder for a
    // known-size file must still show its real size (dropping it made every
    // failed metadata fetch render "0 B"), while an unknown-size file keeps
    // the field absent so callers fall back to "0 B".
    ...(size !== undefined ? { size } : {}),
  };
}

export { stripExtension, hasEmbeddedDurationTag, makePlaceholder };
