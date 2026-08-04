import { db } from "../db/db";
import { captureError } from "./errorLog";

const META_MODULE = "metadata";
export const METADATA_LRU_KEY = "__drplay_metadata_lru";
export const METADATA_KEY_PREFIX = "metadata_";
const UNKNOWN_ARTIST = "Unknown Artist";
const FALLBACK_AUDIO_FILENAME = "audio.mp3";
const METADATA_UPDATED_EVENT = "metadata-updated";
export const V_PLACEHOLDER = 9;
const FRESH_WRITE_WINDOW_MS = 5_000;

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function classifyMetaError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "UnknownError", message: String(err) };
}

const MAX_LRU_CACHE = 100;
let lruKeys: string[] = [];
try {
  const stored = localStorage.getItem(METADATA_LRU_KEY);
  if (stored) {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) lruKeys = parsed;
  }
} catch (e: unknown) {
  captureError({
    level: "warn",
    source: META_MODULE,
    message: `lru-load-failed: ${classifyMetaError(e).message}`,
  });
}

function updateLRU(key: string) {
  lruKeys = lruKeys.filter((k) => k !== key);
  lruKeys.push(key);

  while (lruKeys.length > MAX_LRU_CACHE) {
    const oldest = lruKeys.shift();
    if (oldest) {
      db.metadataCache.delete(oldest).catch((e) =>
        captureError({
          level: "error",
          source: META_MODULE,
          message: `lru-delete-failed: ${classifyMetaError(e).message}`,
        }),
      );
    }
  }

  try {
    localStorage.setItem(METADATA_LRU_KEY, JSON.stringify(lruKeys));
  } catch (e: unknown) {
    captureError({
      level: "warn",
      source: META_MODULE,
      message: `lru-save-failed: ${classifyMetaError(e).message}`,
    });
  }
}

const CACHE_VERSION = 2;
const inflightMetadata = new Map<string, Promise<CachedMetadata>>();
const INFLIGHT_TIMEOUT = 30_000;

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

interface CacheEntry {
  version: number;
  data: CachedMetadata;
  ts: number;
}

async function getCacheEntry(key: string): Promise<CacheEntry | undefined> {
  const row = await db.metadataCache.get(key);
  const entry = row?.entry;
  if (
    entry &&
    typeof entry === "object" &&
    (entry as { version?: unknown }).version === CACHE_VERSION
  ) {
    return entry as CacheEntry;
  }
  return undefined;
}

async function putCacheEntry(key: string, entry: CacheEntry): Promise<void> {
  await db.metadataCache.put({ key, entry });
}

export const metadataCache: Record<string, CachedMetadata> = {};
const MAX_MEM_CACHE = 1000; // 1000 entries cap; entries may carry pictureData (thumb) so real usage can reach tens of MB - bounded by count, not bytes.
const memCacheKeys: string[] = [];

function setMetadataCache(fileId: string, entry: CachedMetadata) {
  if (metadataCache[fileId]) {
    const idx = memCacheKeys.indexOf(fileId);
    if (idx !== -1) memCacheKeys.splice(idx, 1);
  }
  memCacheKeys.push(fileId);
  metadataCache[fileId] = entry;
  while (memCacheKeys.length > MAX_MEM_CACHE) {
    const oldest = memCacheKeys.shift();
    if (oldest) delete metadataCache[oldest];
  }
}

export function cacheTrackMetadata(
  fileId: string,
  entry: CachedMetadata,
): CachedMetadata {
  const stored: CachedMetadata = { ...entry, pictureDataFull: null };
  setMetadataCache(fileId, stored);
  setCache(`${METADATA_KEY_PREFIX}${fileId}`, stored).catch((e) =>
    captureError({
      level: "warn",
      source: META_MODULE,
      message: `cache-set-failed: ${classifyMetaError(e).message}`,
    }),
  );
  return entry;
}

let cacheGeneration = 0;

export function clearAllMetadataCache(): void {
  cacheGeneration++;
  for (const k of Object.keys(metadataCache)) delete metadataCache[k];
  memCacheKeys.length = 0;
  lruKeys = [];
}

async function setCache(key: string, newEntry: CachedMetadata): Promise<void> {
  const genAtStart = cacheGeneration;
  const existing = await getCacheEntry(key);
  if (genAtStart !== cacheGeneration) return;

  const newScore = newEntry.v ?? 0;
  const oldScore = existing?.data?.v ?? 0;

  if (existing && oldScore > newScore) return;
  if (
    existing &&
    oldScore === newScore &&
    existing.ts > Date.now() - FRESH_WRITE_WINDOW_MS
  )
    return;

  await putCacheEntry(key, {
    version: CACHE_VERSION,
    data: newEntry,
    ts: Date.now(),
  });
  updateLRU(key);
}

async function getTrackMetadataImpl(
  fileId: string,
  _token?: string,
  _size?: number,
  name?: string,
  _signal?: AbortSignal,
  forceNetwork: boolean = false,
): Promise<CachedMetadata> {
  if (
    !forceNetwork &&
    metadataCache[fileId] &&
    metadataCache[fileId].v >= V_PLACEHOLDER
  ) {
    return metadataCache[fileId];
  }

  const safeName = name ?? FALLBACK_AUDIO_FILENAME;

  // 1. IDB Check
  if (!forceNetwork) {
    try {
      const cached = await getCacheEntry(`${METADATA_KEY_PREFIX}${fileId}`);
      if (cached && cached.data && cached.data.v >= V_PLACEHOLDER) {
        setMetadataCache(fileId, cached.data);
        return cached.data;
      }
    } catch (e: unknown) {
      captureError({
        level: "warn",
        source: META_MODULE,
        message: `idb-read-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
      });
    }
  }

  // DISABLED: network metadata fetch (HEAD+TAIL range fetch, music-metadata-browser
  // parse, canvas cover compress) and the old SQLite-backed local-metadata IPC.
  // Metadata is now purely placeholder + IDB cache: un-scanned files get a v:9
  // placeholder (memory cache only, not IDB) so subsequent calls are free.

  // Fallback: v:9 placeholder (no cover data)
  const entry: CachedMetadata = {
    title: stripExtension(safeName),
    artist: UNKNOWN_ARTIST,
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: V_PLACEHOLDER,
  };
  setMetadataCache(fileId, entry);
  return entry;
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
    const cached = metadataCache[fileId];
    if (cached && cached.v >= V_PLACEHOLDER) return cached;
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (inflightMetadata.get(fileId) === promise) {
      inflightMetadata.delete(fileId);
    }
  };
  timer = setTimeout(cleanup, INFLIGHT_TIMEOUT);

  promise.then(
    (result) => {
      cleanup();
      return result;
    },
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      captureError({
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
  if (metadataCache[fileId]) {
    metadataCache[fileId].duration = accurateDuration;
    metadataCache[fileId].durationEstimated = false;
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
    captureError({
      level: "warn",
      source: META_MODULE,
      message: `duration-persist-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
    });
  }
  window.dispatchEvent(
    new CustomEvent(METADATA_UPDATED_EVENT, { detail: { fileId } }),
  );
}
