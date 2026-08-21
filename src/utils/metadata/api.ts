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

  let settled = false;
  const removeFromInflight = () => {
    settled = true;
    if (inflightMetadata.get(fileId) === promise) {
      inflightMetadata.delete(fileId);
    }
  };
  // The inflight entry must live for the whole [start → settle] window: a
  // slow pipeline (getTrackMetadataImpl worst case: timeout x2 tries + backoff
  // + semaphore) legitimately outlasts INFLIGHT_TIMEOUT, so deleting the entry
  // on a timer would make late callers spawn a SECOND parallel pipeline for
  // the same fileId (double range requests + double budget). Instead the
  // watchdog below only logs once when the promise is still pending past the
  // window — getTrackMetadataImpl bounds every attempt internally, so hanging
  // beyond it signals another bug rather than something this map can fix.
  const warnStillPending = () => {
    if (settled) return;
    void captureError({
      level: "warn",
      source: META_MODULE,
      message: `inflight-still-pending (fileId=${fileId}): no settle within ${String(INFLIGHT_TIMEOUT)}ms — keeping dedup entry`,
    });
  };
  setTimeout(warnStillPending, INFLIGHT_TIMEOUT);

  promise.then(
    (result) => {
      removeFromInflight();
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
      removeFromInflight();
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
