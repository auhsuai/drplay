export interface CachedMetadata {
  title: string;
  artist: string;
  album?: string;
  duration: number;
  durationEstimated: boolean;
  pictureData: Uint8Array | null;
  pictureDataFull: Uint8Array | null;
  pictureFormat?: string;
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
}

export interface CacheEntry {
  version: number;
  data: CachedMetadata;
  ts: number;
}
