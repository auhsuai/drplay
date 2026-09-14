export interface CachedMetadata {
  title: string;
  artist: string;
  album?: string;
  duration: number;
  durationEstimated: boolean;
  pictureData: Uint8Array | null;
  pictureDataFull: Uint8Array | null;
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
  // Seed offline import (2026-08-10): entries read from <app_cache_dir>/metadata
  // carry no picture bytes — the cover renders via the drplay:// GET from the
  // Rust on-disk cover cache. coverOnDisk flips the hook's <img src> to
  // buildCoverUrl (drplay://cover?id=...) instead of a blob URL.
  coverOnDisk?: boolean;
  // Extended fields from the Colab scanner; displayed by the UI in a later
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
