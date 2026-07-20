import { get, set, del } from 'idb-keyval';
import { invoke } from "@tauri-apps/api/core";

const META_MODULE = "metadata";

function classifyMetaError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "UnknownError", message: String(err) };
}

const MAX_LRU_CACHE = 100;
let lruKeys: string[] = [];
try {
  const stored = localStorage.getItem('__drplay_metadata_lru');
  if (stored) lruKeys = JSON.parse(stored);
} catch (e) {
  console.warn(`[${META_MODULE}] lru-load-failed`, classifyMetaError(e));
}

function updateLRU(key: string) {
  lruKeys = lruKeys.filter(k => k !== key);
  lruKeys.push(key);
  
  while (lruKeys.length > MAX_LRU_CACHE) {
    const oldest = lruKeys.shift();
    if (oldest) {
      del(oldest).catch(e => console.error(`[${META_MODULE}] lru-delete-failed`, classifyMetaError(e)));
    }
  }
  
  try {
    localStorage.setItem('__drplay_metadata_lru', JSON.stringify(lruKeys));
  } catch (e) {
    console.warn(`[${META_MODULE}] lru-save-failed`, classifyMetaError(e));
  }
}

class ConcurrencyQueue {
  private queue: (() => void)[] = [];
  private activeCount = 0;
  constructor(private concurrency: number) {}
  async enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Promise((resolve, reject) => {
      const run = async () => {
        if (signal?.aborted) {
          this.activeCount--;
          this.dequeue();
          return reject(new DOMException("Aborted", "AbortError"));
        }
        try {
          resolve(await task());
        } catch (e) {
          reject(e);
        } finally {
          this.activeCount--;
          this.dequeue();
        }
      };
      if (this.activeCount < this.concurrency) {
        this.activeCount++;
        run();
      } else {
        this.queue.push(run);
      }
    });
  }
  private dequeue() {
    if (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const next = this.queue.shift();
      if (next) {
        this.activeCount++;
        next();
      }
    }
  }
}
const metadataQueue = new ConcurrencyQueue(3);

const HEAD_BYTES = 65536;
const TAIL_BYTES = 131072;
const MAX_COVER_FETCH = 50 * 1024 * 1024;
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

export const metadataCache: Record<string, CachedMetadata> = {};
const MAX_MEM_CACHE = 300;
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
  setCache(`metadata_${fileId}`, stored, true).catch((e) => console.warn(`[${META_MODULE}] cache-set-failed`, classifyMetaError(e)));
  return entry;
}

export function clearAllMetadataCache(): void {
  for (const k of Object.keys(metadataCache)) delete metadataCache[k];
  memCacheKeys.length = 0;
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
    wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    wma: 'audio/x-ms-wma', opus: 'audio/opus',
  };
  return map[ext] || 'audio/mpeg';
}

function isImageTruncated(data: Uint8Array): boolean {
  if (data.length < 8) return true;
  if (data[0] === 0xFF && data[1] === 0xD8) {
    return !(data[data.length - 2] === 0xFF && data[data.length - 1] === 0xD9);
  }
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    const iend = new Uint8Array([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    const tail = data.slice(-8);
    return !iend.every((b, i) => tail[i] === b);
  }
  return false;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

async function parseMultipartByteRanges(response: Response): Promise<Uint8Array[]> {
  const contentType = response.headers.get('Content-Type') || '';
  const boundaryMatch = contentType.match(/boundary=([^;]+)/);
  const buf = new Uint8Array(await response.arrayBuffer());

  if (!boundaryMatch) {
    return [buf];
  }

  const boundary = `--${boundaryMatch[1]}`;
  const boundaryBytes = new TextEncoder().encode(boundary);
  const parts: Uint8Array[] = [];

  let searchStart = 0;
  const indices: number[] = [];
  while (true) {
    const idx = indexOfBytes(buf, boundaryBytes, searchStart);
    if (idx === -1) break;
    indices.push(idx);
    searchStart = idx + boundaryBytes.length;
  }

  for (let i = 0; i < indices.length - 1; i++) {
    const sectionStart = indices[i] + boundaryBytes.length;
    const sectionEnd = indices[i + 1];
    const section = buf.slice(sectionStart, sectionEnd);
    const headerEnd = indexOfBytes(section, new TextEncoder().encode('\r\n\r\n'), 0);
    if (headerEnd === -1) continue;
    let body = section.slice(headerEnd + 4);
    if (body.length >= 2 && body[body.length - 1] === 0x0A && body[body.length - 2] === 0x0D) {
      body = body.slice(0, body.length - 2);
    }
    parts.push(body);
  }

  return parts;
}

async function setCache(
  key: string,
  newEntry: CachedMetadata,
  skipVerify: boolean = false,
): Promise<void> {
  if (newEntry.dbId && !skipVerify) {
    try {
      const exists = await invoke<boolean>('verify_track_exists', { dbId: newEntry.dbId });
      if (!exists) {
        newEntry.dbId = undefined;
        newEntry.v = Math.min(newEntry.v ?? 0, 9);
        newEntry.coverUrl = undefined;
        newEntry.fullCoverUrl = undefined;
      }
    } catch {
      // IPC error — keep entry, don't block user
    }
  }

  const existing = await get<CacheEntry>(key);
  const newHasDbId = !!newEntry.dbId;
  const oldHasDbId = !!existing?.data?.dbId;

  if (oldHasDbId && !newHasDbId) return;

  const newScore = newHasDbId ? 100 : (newEntry.v ?? 0);
  const oldScore = oldHasDbId ? 100 : (existing?.data?.v ?? 0);

  if (existing && oldScore > newScore) return;
  if (existing && oldScore === newScore && existing.ts > Date.now() - 5000) return;

  await set(key, { version: CACHE_VERSION, data: newEntry, ts: Date.now() });
  updateLRU(key);
}

async function compressImage(
  data: Uint8Array,
  format: string,
  maxSize: number = 256,
  quality: number = 0.7,
): Promise<Uint8Array> {
  const blob = new Blob([data], { type: format });
  const img = await createImageBitmap(blob);

  if (img.width <= maxSize && img.height <= maxSize) {
    return data;
  }

  const scale = Math.min(maxSize / img.width, maxSize / img.height);
  const w = Math.floor(img.width * scale);
  const h = Math.floor(img.height * scale);

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const compressed = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await compressed.arrayBuffer());
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      if (blob) {
        resolve(new Uint8Array(await blob.arrayBuffer()));
      } else {
        resolve(data);
      }
    }, 'image/jpeg', quality);
  });
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
  const safeName = name ?? 'audio.mp3';

  // 0. IDB Check
  if (!forceNetwork) {
    try {
      const cached = await get<CacheEntry>(`metadata_${fileId}`);
      if (cached && cached.data && cached.data.v >= 9) {
        setMetadataCache(fileId, cached.data);
        return cached.data;
      }
    } catch {
      // ignore IDB error
    }
  }

  // 1. Dedup check
  if (!forceNetwork) {
    try {
      const local = await invoke<{ id: string; title: string; artist: string; album: string; duration: number; has_cover: boolean; file_type: string } | null>('get_local_metadata', {
        size: Number(safeSize),
        name: safeName,
      });
      if (local?.id) {
        const entry = {
          title: local.title || safeName.replace(/\.[^.]+$/, ''),
          artist: local.artist || 'Unknown Artist',
          album: local.album,
          duration: local.duration,
          durationEstimated: false,
          pictureData: null,
          pictureDataFull: null,
          dbId: local.id,
          coverUrl: local.has_cover ? `http://drplay.localhost/cover?id=${local.id}&thumb=true&v=2` : undefined,
          fullCoverUrl: local.has_cover ? `http://drplay.localhost/cover?id=${local.id}&thumb=false&v=2` : undefined,
          size: safeSize,
          v: 10,
        };
        setMetadataCache(fileId, entry);
        return entry;
      }
    } catch {
      // continue to network fetch
    }
  }

  // DISABLED: network metadata fetch (HEAD+TAIL range fetch, music-metadata-browser parse,
  // canvas cover compress). Metadata comes exclusively from local DB (get_local_metadata
  // above) and R2/proxy cover URLs. Un-scanned files get a v:9 placeholder (only memory
  // cache, not IDB) so subsequent calls skip IPC/get_local_metadata entirely.
  const entry: CachedMetadata = {
    title: safeName.replace(/\.[^.]+$/, ''),
    artist: 'Unknown Artist',
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: 9,
  };
  setMetadataCache(fileId, entry);
  return entry;
}

// dead-code references (kept for re-enable)
void [metadataQueue, HEAD_BYTES, TAIL_BYTES, MAX_COVER_FETCH, guessMime, isImageTruncated, parseMultipartByteRanges, compressImage];

export async function getTrackMetadata(
  fileId: string,
  token?: string,
  size?: number,
  name?: string,
  _signal?: AbortSignal,
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

  const promise = getTrackMetadataImpl(fileId, token, size, name, _signal, forceNetwork);

  inflightMetadata.set(fileId, promise);

  promise.catch(() => {
    /* suppressed — callers handle their own errors via the returned promise */
  });

  const timeoutId = setTimeout(() => {
    if (inflightMetadata.get(fileId) === promise) {
      inflightMetadata.delete(fileId);
    }
  }, INFLIGHT_TIMEOUT);

  promise.finally(() => {
    clearTimeout(timeoutId);
    if (inflightMetadata.get(fileId) === promise) {
      inflightMetadata.delete(fileId);
    }
  });

  return promise;
}

export async function updateTrackDuration(fileId: string, accurateDuration: number): Promise<void> {
  if (metadataCache[fileId]) {
    metadataCache[fileId].duration = accurateDuration;
    metadataCache[fileId].durationEstimated = false;
  }
  const key = `metadata_${fileId}`;
  const entry = await get<CacheEntry>(key);
  if (entry?.data) {
    entry.data.duration = accurateDuration;
    entry.data.durationEstimated = false;
    entry.ts = Date.now();
    await set(key, entry);

    if (entry.data.dbId) {
      try {
        await invoke('update_track_duration_in_db', { dbId: entry.data.dbId, duration: accurateDuration });
      } catch (e) {
        console.error(`[${META_MODULE}] duration-sync-failed`, classifyMetaError(e));
      }
    }
    window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId } }));
  }
}
