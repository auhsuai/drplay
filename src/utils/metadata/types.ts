/**
 * Explicit lifecycle of a metadata result (Phase A6). Before this, a resolved
 * value could only be told apart by the numeric `v` marker, so a transient
 * failure was indistinguishable from a successful load for every consumer.
 *
 * - "success":   full parse (or a cache hit of one).
 * - "partial":   parsed text metadata, cover degraded (budget salvage). Still
 *                real, usable metadata — rendered exactly like "success".
 * - "no_metadata": the file IS a valid audio file but carries no usable tags
 *                (title falls back to the filename).
 * - "unsupported": deterministic — the format/media kind cannot be parsed or
 *                the server refuses Range. Pinned; never retried.
 * - "transient_failure": timeout/network/rate-limited. Provisional: retried
 *                after the per-file cooldown, never pinned.
 * - "circuit_open": rejected by the app-wide throttle breaker. Provisional
 *                and GLOBAL — never punished with a per-file cooldown.
 * - "cancelled": deliberate caller cancellation. Not a failure; retryable by
 *                the next mount with no cooldown.
 */
export type MetadataOutcome =
  | "success"
  | "partial"
  | "no_metadata"
  | "unsupported"
  | "transient_failure"
  | "circuit_open"
  | "cancelled";

export interface CachedMetadata {
  title: string;
  artist: string;
  album?: string;
  duration: number;
  durationEstimated: boolean;
  pictureData: Uint8Array | null;
  pictureDataFull: Uint8Array | null;
  /** Discriminated outcome (absent on legacy rows — treat as v-derived). */
  outcome?: MetadataOutcome;
  /**
   * True when the entry is a RETRYABLE placeholder (transient failure,
   * circuit rejection or cancellation): keep rendering it (filename, "–"), but
   * consumers must not treat it as a completed load — a later attempt can
   * still produce real metadata. Deterministic placeholders
   * (unsupported/no_metadata) are rendered the same way but leave this false,
   * because retrying cannot change the answer.
   */
  provisional?: boolean;
  pictureFormat?: string;
  // Format of `pictureDataFull` when it differs from the thumb's
  // pictureFormat: each cover variant is compressed independently, so a
  // >THUMB_MAX_SIZE PNG/WebP source yields a re-encoded JPEG thumb with the
  // ORIGINAL PNG/WebP kept for the full variant. The persist gate and the
  // consumer blob MIME must judge the full bytes by their own format.
  pictureFullFormat?: string;
  bitrate?: number;
  size?: number;
  v: number;
  // coverOnDisk flips the hook's <img src> to buildCoverUrl
  // (drplay://cover?id=...) instead of a blob URL, for entries whose cover
  // lives only in the Rust on-disk cache. No producer sets it today — kept
  // for a possible future on-disk metadata source.
  coverOnDisk?: boolean;
  // Extended fields from external scanners; displayed by the UI in a later
  // task — the metadata pipeline just carries them through.
  genre?: string;
  year?: number;
  trackNumber?: number;
  albumArtist?: string;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  // Non-faststart m4a (moov after mdat): the file cannot be streamed
  // progressively. Set by fetchPipeline when the box walk detects the
  // layout; usePlayer gates the first user play attempt (the immediately
  // repeated click on the same track forces playback).
  streamUnplayable?: boolean;
}

export interface CacheEntry {
  version: number;
  data: CachedMetadata;
  ts: number;
}
