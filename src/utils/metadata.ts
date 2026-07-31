import { db } from "../db/db";
import { invoke } from "@tauri-apps/api/core";
import { captureError } from './errorLog';

const META_MODULE = "metadata";
const METADATA_LRU_KEY = '__drplay_metadata_lru';
const METADATA_KEY_PREFIX = 'metadata_';
const UNKNOWN_ARTIST = 'Unknown Artist';
const FALLBACK_AUDIO_FILENAME = 'audio.mp3';
const METADATA_UPDATED_EVENT = 'metadata-updated';
const IPC_GET_LOCAL_METADATA = 'get_local_metadata';
const IPC_VERIFY_TRACK_EXISTS = 'verify_track_exists';
const IPC_UPDATE_TRACK_DURATION = 'update_track_duration_in_db';
const COVER_URL_BASE = 'http://drplay.localhost/cover';

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
  if (stored) lruKeys = JSON.parse(stored);
} catch (e: unknown) {
  captureError({ level: 'warn', source: META_MODULE, message: `lru-load-failed: ${classifyMetaError(e).message}` });
}

function updateLRU(key: string) {
  lruKeys = lruKeys.filter(k => k !== key);
  lruKeys.push(key);
  
  while (lruKeys.length > MAX_LRU_CACHE) {
    const oldest = lruKeys.shift();
    if (oldest) {
      db.metadataCache.delete(oldest).catch(e => captureError({ level: 'error', source: META_MODULE, message: `lru-delete-failed: ${classifyMetaError(e).message}` }));
    }
  }
  
  try {
    localStorage.setItem(METADATA_LRU_KEY, JSON.stringify(lruKeys));
  } catch (e: unknown) {
    captureError({ level: 'warn', source: META_MODULE, message: `lru-save-failed: ${classifyMetaError(e).message}` });
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
  dbId?: string;
  coverUrl?: string;
  fullCoverUrl?: string;
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
  return row?.entry as CacheEntry | undefined;
}

async function putCacheEntry(key: string, entry: CacheEntry): Promise<void> {
  await db.metadataCache.put({ key, entry });
}

export const metadataCache: Record<string, CachedMetadata> = {};
const MAX_MEM_CACHE = 1000; // ~300KB max (300 bytes/entry for metadata title+artist+duration)
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

export function cacheTrackMetadata(fileId: string, entry: CachedMetadata): CachedMetadata {
  const stored: CachedMetadata = { ...entry, pictureDataFull: null };
  setMetadataCache(fileId, stored);
  setCache(`${METADATA_KEY_PREFIX}${fileId}`, stored, true).catch((e) => captureError({ level: 'warn', source: META_MODULE, message: `cache-set-failed: ${classifyMetaError(e).message}` }));
  return entry;
}

export function clearAllMetadataCache(): void {
  for (const k of Object.keys(metadataCache)) delete metadataCache[k];
  memCacheKeys.length = 0;
}

async function setCache(
  key: string,
  newEntry: CachedMetadata,
  skipVerify: boolean = false,
): Promise<void> {
  if (newEntry.dbId && !skipVerify) {
    try {
      const exists = await invoke<boolean>(IPC_VERIFY_TRACK_EXISTS, { dbId: newEntry.dbId });
      if (!exists) {
        newEntry.dbId = undefined;
        newEntry.v = Math.min(newEntry.v ?? 0, 9);
        newEntry.coverUrl = undefined;
        newEntry.fullCoverUrl = undefined;
      }
      } catch (e: unknown) {
        captureError({ level: 'warn', source: META_MODULE, message: `verify-track-exists-failed (dbId=${String(newEntry.dbId)}): ${classifyMetaError(e).message}` });
      }
    }

  const existing = await getCacheEntry(key);
  const newHasDbId = !!newEntry.dbId;
  const oldHasDbId = !!existing?.data?.dbId;

  if (oldHasDbId && !newHasDbId) return;

  const newScore = newHasDbId ? 100 : (newEntry.v ?? 0);
  const oldScore = oldHasDbId ? 100 : (existing?.data?.v ?? 0);

  if (existing && oldScore > newScore) return;
  if (existing && oldScore === newScore && existing.ts > Date.now() - 5000) return;

  await putCacheEntry(key, { version: CACHE_VERSION, data: newEntry, ts: Date.now() });
  updateLRU(key);
}

async function getTrackMetadataImpl(
  fileId: string,
  _token?: string,
  size?: number,
  name?: string,
  _signal?: AbortSignal,
  forceNetwork: boolean = false,
): Promise<CachedMetadata> {
  if (!forceNetwork && metadataCache[fileId] && metadataCache[fileId].v >= 9) {
    return metadataCache[fileId];
  }

  const safeSize = size ?? 0;
  const safeName = name ?? FALLBACK_AUDIO_FILENAME;

  // 0. IDB Check
  if (!forceNetwork) {
    try {
      const cached = await getCacheEntry(`${METADATA_KEY_PREFIX}${fileId}`);
      if (cached && cached.data && cached.data.v >= 9) {
        setMetadataCache(fileId, cached.data);
        return cached.data;
      }
    } catch (e: unknown) {
      captureError({ level: 'warn', source: META_MODULE, message: `idb-read-failed (fileId=${fileId}): ${classifyMetaError(e).message}` });
    }
  }

  // 1. Dedup check
  if (!forceNetwork) {
    try {
      const local = await invoke<{ id: string; title: string; artist: string; album: string; duration: number; has_cover: boolean; file_type: string } | null>(IPC_GET_LOCAL_METADATA, {
        size: Number(safeSize),
        name: safeName,
      });
      if (local?.id) {
        const entry = {
          title: local.title || safeName.replace(/\.[^.]+$/, ''),
          artist: local.artist || UNKNOWN_ARTIST,
          album: local.album,
          duration: local.duration,
          durationEstimated: false,
          pictureData: null,
          pictureDataFull: null,
          dbId: local.id,
          coverUrl: local.has_cover ? `${COVER_URL_BASE}?id=${local.id}&thumb=true&v=2` : undefined,
          fullCoverUrl: local.has_cover ? `${COVER_URL_BASE}?id=${local.id}&thumb=false&v=2` : undefined,
          size: safeSize,
          v: 10,
        };
        setMetadataCache(fileId, entry);
        return entry;
      }
    } catch (e: unknown) {
      captureError({ level: 'warn', source: META_MODULE, message: `local-metadata-failed (fileId=${fileId}, size=${safeSize}, name=${safeName}): ${classifyMetaError(e).message}` });
    }
  }

  // DISABLED: network metadata fetch (HEAD+TAIL range fetch, music-metadata-browser parse,
  // canvas cover compress). Metadata comes exclusively from local DB (get_local_metadata
  // above) and R2/proxy cover URLs. Un-scanned files get a v:9 placeholder (only memory
  // cache, not IDB) so subsequent calls skip IPC/get_local_metadata entirely.

  // Fallback: v:9 placeholder (no cover data)
  const entry: CachedMetadata = {
    title: safeName.replace(/\.[^.]+$/, ''),
    artist: UNKNOWN_ARTIST,
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: 9,
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
    if (cached && cached.v >= 9) return cached;
  }

  if (!forceNetwork) {
    const existing = inflightMetadata.get(fileId);
    if (existing) return existing;
  }

  const promise = getTrackMetadataImpl(fileId, token, size, name, signal, forceNetwork);

  inflightMetadata.set(fileId, promise);

  promise.catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[metadata] getTrackMetadata failed', { fileId, error: msg });
  });

  const cleanup = () => {
    if (inflightMetadata.get(fileId) === promise) {
      inflightMetadata.delete(fileId);
    }
  };
  AbortSignal.timeout(INFLIGHT_TIMEOUT).addEventListener('abort', cleanup, { once: true });
  promise.finally(cleanup);

  return promise;
}

export async function updateTrackDuration(fileId: string, accurateDuration: number): Promise<void> {
  if (metadataCache[fileId]) {
    metadataCache[fileId].duration = accurateDuration;
    metadataCache[fileId].durationEstimated = false;
  }
  const key = `${METADATA_KEY_PREFIX}${fileId}`;
  const entry = await getCacheEntry(key);
  if (entry?.data) {
    entry.data.duration = accurateDuration;
    entry.data.durationEstimated = false;
    entry.ts = Date.now();
    await putCacheEntry(key, entry);

    if (entry.data.dbId) {
      try {
        await invoke(IPC_UPDATE_TRACK_DURATION, { dbId: entry.data.dbId, duration: accurateDuration });
      } catch (e: unknown) {
        captureError({ level: 'error', source: META_MODULE, message: `duration-sync-failed: ${classifyMetaError(e).message}` });
      }
    }
    window.dispatchEvent(new CustomEvent(METADATA_UPDATED_EVENT, { detail: { fileId } }));
  }
}
