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
}

export interface CacheEntry {
  version: number;
  data: CachedMetadata;
  ts: number;
}
