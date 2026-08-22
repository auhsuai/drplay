export {
  COVER_SLACK_BYTES,
  FULL_PERSIST_MAX_BYTES,
  LARGE_FILE_THRESHOLD,
  METADATA_KEY_PREFIX,
  METADATA_LRU_KEY,
  TAG_BUDGET_MAX,
  UNKNOWN_ARTIST,
  V_PLACEHOLDER,
} from "./metadata/constants";
export type { CachedMetadata } from "./metadata/types";
export {
  cacheTrackMetadata,
  clearAllMetadataCache,
  getFullPictureData,
  metadataCache,
  wipePersistedMetadataCache,
} from "./metadata/cache";
export { getTrackMetadata, updateTrackDuration } from "./metadata/api";
