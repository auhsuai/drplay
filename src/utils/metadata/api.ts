import { captureError } from "../errorLog";
import { raceWithAbortSignal } from "../apiClientShared";
import { getMemCacheEntry, mergeFullPicture } from "./cache";
import { INFLIGHT_TIMEOUT, META_MODULE } from "./constants";
import { getTrackMetadataImpl } from "./fetchPipeline";
import type { CachedMetadata } from "./types";

// In-flight dedupe entry. The shared work is bound to the entry's OWN
// AbortController — never to a caller's signal: one consumer unmounting must
// not cancel the parse another mounted consumer (TrackInfo/NowPlaying/SongCard
// all fetch the same fileId) is still waiting on. Every caller, creator
// included, races the entry promise with its own signal and drops the
// refcount when it leaves; the shared work is aborted only when the LAST
// caller is gone (refs === 0).
interface InflightEntry {
  promise: Promise<CachedMetadata>;
  controller: AbortController;
  refs: number;
}

const inflightMetadata = new Map<string, InflightEntry>();

// Dedupe identity includes the arguments the pipeline is built from. Keying on
// fileId alone let a joiner inherit a result computed for DIFFERENT args: a
// caller with size<=0 pins its placeholder in the memory cache by fileId
// (fetchPipeline), so every later caller — real size included — was served
// that placeholder until a clear/forceNetwork. Same args still dedupe.
function inflightKey(fileId: string, size?: number, name?: string): string {
  return `${fileId}|${String(size ?? 0)}|${name ?? ""}`;
}

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

  const key = inflightKey(fileId, size, name);

  if (!forceNetwork) {
    const existing = inflightMetadata.get(key);
    if (existing) {
      existing.refs += 1;
      try {
        // The joiner escapes as soon as ITS signal aborts without touching
        // the shared promise (raceWithAbortSignal: abort is per-caller).
        return await raceWithAbortSignal(existing.promise, signal);
      } finally {
        existing.refs -= 1;
        if (existing.refs === 0) existing.controller.abort();
      }
    }
  }

  const controller = new AbortController();
  const promise = getTrackMetadataImpl(
    fileId,
    token,
    size,
    name,
    controller.signal,
    forceNetwork,
  );
  const entry: InflightEntry = { promise, controller, refs: 1 };

  inflightMetadata.set(key, entry);

  let settled = false;
  const removeFromInflight = () => {
    settled = true;
    if (inflightMetadata.get(key) === entry) {
      inflightMetadata.delete(key);
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

  try {
    // Same per-caller escape as the joiner path above: the creator's signal
    // must not be wired into the shared work (that is exactly the bug where
    // the first consumer's unmount poisoned every other consumer), and the
    // creator must not be left waiting on work nobody else refs anymore —
    // the finally below aborts the shared work once refs hits 0.
    return await raceWithAbortSignal(promise, signal);
  } finally {
    entry.refs -= 1;
    if (entry.refs === 0) entry.controller.abort();
  }
}
