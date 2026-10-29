import {
  classifyMetaError,
  getCacheEntry,
  mergeFullPicture,
  setFullPictureCache,
  setMetadataCache,
} from "./cache";
import { METADATA_KEY_PREFIX } from "./constants";
import { logMetaWarn } from "./pipelineHelpers";
import type { CachedMetadata } from "./types";

export async function readCachedEntry(
  fileId: string,
  forceNetwork: boolean,
): Promise<CachedMetadata | null> {
  // 1. IDB Check
  if (!forceNetwork) {
    try {
      const cached = await getCacheEntry(`${METADATA_KEY_PREFIX}${fileId}`);
      if (cached) {
        let cachedData = cached.data;
        if (cachedData.pictureDataFull) {
          // Restart path: seed the memory LRU from the persisted full JPEG so
          // cards render sharp immediately. The mem entry still stays
          // full-free — the LRU is the single owner of full bytes (the seeded
          // value is re-attached by mergeFullPicture below).
          // A corrupt row (isCacheEntry guards only the envelope) must not
          // poison the LRU: a non-Uint8Array value has no byteLength (NaN
          // byte accounting) and an empty array renders a 0-byte cover
          // instead of falling back to the thumb — seed only real bytes,
          // then drop the field either way.
          if (
            cachedData.pictureDataFull instanceof Uint8Array &&
            cachedData.pictureDataFull.byteLength > 0
          ) {
            setFullPictureCache(fileId, cachedData.pictureDataFull);
          }
          cachedData = { ...cachedData, pictureDataFull: null };
        }
        setMetadataCache(fileId, cachedData);
        return mergeFullPicture(fileId, cachedData);
      }
    } catch (e: unknown) {
      await logMetaWarn(
        `idb-read-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
      );
    }
  }

  return null;
}
