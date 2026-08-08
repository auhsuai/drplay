import { captureError } from "../errorLog";
import {
  classifyMetaError,
  getCacheEntry,
  getMemCacheEntry,
  mergeFullPicture,
  putCacheEntry,
} from "./cache";
import {
  INFLIGHT_TIMEOUT,
  METADATA_KEY_PREFIX,
  METADATA_UPDATED_EVENT,
  META_MODULE,
} from "./constants";
import { getTrackMetadataImpl } from "./fetchPipeline";
import type { CachedMetadata } from "./types";

const inflightMetadata = new Map<string, Promise<CachedMetadata>>();

export async function getTrackMetadata(
  fileId: string,
  token?: string,
  size?: number,
  name?: string,
  signal?: AbortSignal,
  forceNetwork: boolean = false,
): Promise<CachedMetadata> {
  if (!forceNetwork) {
    // fileId with no cached entry is undefined at runtime — guard it.
    const cached = getMemCacheEntry(fileId);
    if (cached) return mergeFullPicture(fileId, cached);
  }

  if (!forceNetwork) {
    const existing = inflightMetadata.get(fileId);
    if (existing) return existing;
  }

  const promise = getTrackMetadataImpl(
    fileId,
    token,
    size,
    name,
    signal,
    forceNetwork,
  );

  inflightMetadata.set(fileId, promise);

  const cleanup = () => {
    if (inflightMetadata.get(fileId) === promise) {
      inflightMetadata.delete(fileId);
    }
  };
  // Once the timeout fires or the promise settles, cleanup removes the
  // inflight entry — the guard makes the delete idempotent, so an early
  // settle followed by the later timer firing is a harmless no-op.
  setTimeout(cleanup, INFLIGHT_TIMEOUT);

  promise.then(
    (result) => {
      cleanup();
      return result;
    },
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // fire-and-forget: logging must not throw in this sync callback
      // (captureError never rejects — it swallows failures internally).
      void captureError({
        level: "error",
        source: META_MODULE,
        message: `get-track-metadata-failed (fileId=${fileId}): ${msg}`,
      });
      cleanup();
    },
  );

  return promise;
}

export async function updateTrackDuration(
  fileId: string,
  accurateDuration: number,
): Promise<void> {
  // fileId with no cached entry is undefined at runtime — guard it.
  const memEntry = getMemCacheEntry(fileId);
  if (memEntry) {
    memEntry.duration = accurateDuration;
    memEntry.durationEstimated = false;
  }
  // IDB persistence is best-effort: the memory cache above is the source of
  // truth for the current session, so a store failure must not reject the
  // caller — log and still notify listeners (they re-read from memory).
  try {
    const key = `${METADATA_KEY_PREFIX}${fileId}`;
    const entry = await getCacheEntry(key);
    if (entry?.data) {
      entry.data.duration = accurateDuration;
      entry.data.durationEstimated = false;
      entry.ts = Date.now();
      await putCacheEntry(key, entry);
    }
  } catch (e: unknown) {
    await captureError({
      level: "warn",
      source: META_MODULE,
      message: `duration-persist-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
    });
  }
  window.dispatchEvent(
    new CustomEvent(METADATA_UPDATED_EVENT, { detail: { fileId } }),
  );
}
