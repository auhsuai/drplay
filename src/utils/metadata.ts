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

const HEAD_BYTES = 262144;
const TAIL_BYTES = 131072;
const MAX_COVER_FETCH = 50 * 1024 * 1024;
const CACHE_VERSION = 2;

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

export async function getTrackMetadata(
  fileId: string,
  token?: string,
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

  // If no token, return empty metadata (cache-only path for UI components)
  if (!token) {
    const entry = {
      title: safeName.replace(/\.[^.]+$/, ''),
      artist: 'Unknown Artist',
      duration: 0,
      durationEstimated: true,
      pictureData: null,
      pictureDataFull: null,
      v: 0,
    };
    setMetadataCache(fileId, entry);
    return entry;
  }

  // 2. Fetch HEAD + TAIL in one multipart request
  return metadataQueue.enqueue(async () => {
    const tailStart = Math.max(HEAD_BYTES, safeSize - TAIL_BYTES);
    const tailEnd = Math.max(0, safeSize - 1);
    const rangeHeader = tailEnd < tailStart
      ? `bytes=0-${HEAD_BYTES - 1}`
      : `bytes=0-${HEAD_BYTES - 1},${tailStart}-${tailEnd}`;

    const rangeSignal = _signal
      ? AbortSignal.any([_signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    const response = await fetch(`http://drplay.localhost/stream?id=${encodeURIComponent(fileId)}`, {
      headers: { Range: rangeHeader },
      signal: rangeSignal,
    });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch metadata range: ${response.status}`);
  }

  const parts = await parseMultipartByteRanges(response);
  const headBuffer = parts[0] || new Uint8Array();
  const tailBuffer = parts[1] || new Uint8Array();

  if (headBuffer.length === 0) {
    throw new Error('Empty head buffer — file may be corrupt');
  }

  // 3. Dynamic Header Expansion
  let finalHeadBuffer = headBuffer;

  if (headBuffer.length >= 10 && headBuffer[0] === 0x49 && headBuffer[1] === 0x44 && headBuffer[2] === 0x33) {
    // ID3v2 tag detected
    const tagSize = ((headBuffer[6] & 0x7f) << 21) | ((headBuffer[7] & 0x7f) << 14) | ((headBuffer[8] & 0x7f) << 7) | (headBuffer[9] & 0x7f);
    const totalTagSize = tagSize + 10;
    
    if (totalTagSize > headBuffer.length) {
      const fetchUpTo = Math.min(totalTagSize, 20 * 1024 * 1024); // Cap at 20MB
      if (fetchUpTo > headBuffer.length) {
        try {
          const extraResp = await fetch(`http://drplay.localhost/stream?id=${encodeURIComponent(fileId)}`, {
            headers: { Range: `bytes=${headBuffer.length}-${fetchUpTo - 1}` },
            signal: _signal,
          });
          if (extraResp.ok || extraResp.status === 206) {
            const extraBuffer = new Uint8Array(await extraResp.arrayBuffer());
            const combined = new Uint8Array(headBuffer.length + extraBuffer.length);
            combined.set(headBuffer, 0);
            combined.set(extraBuffer, headBuffer.length);
            finalHeadBuffer = combined;
          }
        } catch (e) {
          console.warn(`[${META_MODULE}] expand-id3-failed`, classifyMetaError(e));
        }
      }
    }
  } else if (headBuffer.length >= 8 && headBuffer[4] === 0x66 && headBuffer[5] === 0x74 && headBuffer[6] === 0x79 && headBuffer[7] === 0x70) {
    // M4A / MP4 'ftyp' box detected
    let moovOffset = -1;
    let moovSize = 0;
    for (let i = 0; i < headBuffer.length - 8; i++) {
      if (headBuffer[i+4] === 0x6D && headBuffer[i+5] === 0x6F && headBuffer[i+6] === 0x6F && headBuffer[i+7] === 0x76) { // 'moov'
        moovSize = (headBuffer[i] << 24) | (headBuffer[i+1] << 16) | (headBuffer[i+2] << 8) | headBuffer[i+3];
        moovOffset = i;
        break;
      }
    }
    if (moovOffset !== -1) {
      const requiredBytes = moovOffset + moovSize;
      if (requiredBytes > headBuffer.length) {
        const fetchUpTo = Math.min(requiredBytes, 20 * 1024 * 1024);
        if (fetchUpTo > headBuffer.length) {
          try {
            const extraResp = await fetch(`http://drplay.localhost/stream?id=${encodeURIComponent(fileId)}`, {
              headers: { Range: `bytes=${headBuffer.length}-${fetchUpTo - 1}` },
              signal: _signal,
            });
            if (extraResp.ok || extraResp.status === 206) {
              const extraBuffer = new Uint8Array(await extraResp.arrayBuffer());
              const combined = new Uint8Array(headBuffer.length + extraBuffer.length);
              combined.set(headBuffer, 0);
              combined.set(extraBuffer, headBuffer.length);
              finalHeadBuffer = combined;
            }
          } catch (e) {
            console.warn(`[${META_MODULE}] expand-moov-failed`, classifyMetaError(e));
          }
        }
      }
    }
  }

  // 4. Parse HEAD
  const mm = await import('music-metadata-browser');
  let parsed = await mm.parseBuffer(finalHeadBuffer, { mimeType: guessMime(safeName), size: safeSize });

  // 4. Duration: try TAIL if HEAD has none
  let duration = parsed.format.duration;
  let durationEstimated = false;
  if (!duration && tailBuffer.length > 0) {
    try {
      const tailParsed = await mm.parseBuffer(tailBuffer, { mimeType: guessMime(safeName), size: safeSize });
      duration = tailParsed.format.duration;
    } catch {
      // intentional fallback: TAIL parse failing is normal (no trailing metadata); fall through to estimation. Do NOT warn — would spam on every track.
    }
  }

  // 5. Set duration to 0 if missing (will be updated dynamically by UI Player)
  if (!duration) {
    duration = 0;
    durationEstimated = true;
  }

  // 6. Cover: fetch full image, create thumbnail
  let pictureData: Uint8Array | null = null;
  let pictureDataFull: Uint8Array | null = null;
  let pictureFormat: string | undefined;

  const pic = parsed.common.picture?.[0];
  if (pic) {
    pictureFormat = pic.format;

    const declaredSize = (pic as any).declaredSize ?? pic.data.length;
    if (declaredSize > MAX_COVER_FETCH) {
      console.warn(`[${META_MODULE}] cover-too-large (${declaredSize} bytes > ${MAX_COVER_FETCH}), skipping to avoid memory issues`);
    } else if (isImageTruncated(pic.data)) {
      const offset = (pic as any).offset ?? 0;
      if (declaredSize > 0 && offset + declaredSize <= safeSize) {
        try {
          const picResp = await fetch(`http://drplay.localhost/stream?id=${encodeURIComponent(fileId)}`, {
            headers: { Range: `bytes=${offset}-${offset + declaredSize - 1}` },
            signal: _signal,
          });
          if (picResp.ok || picResp.status === 206) {
            const fullPic = new Uint8Array(await picResp.arrayBuffer());
            if (!isImageTruncated(fullPic)) {
              pictureDataFull = fullPic;
              pictureData = await compressImage(fullPic, pic.format, 256, 0.7);
            }
          }
        } catch {
          // intentional fallback: truncated cover that can't be fetched via range is common; skip cover silently. Do NOT warn — would spam.
        }
      }
    } else {
      pictureDataFull = pic.data;
      pictureData = await compressImage(pic.data, pic.format, 256, 0.7);
    }
  }

  const entry: CachedMetadata = {
    title: parsed.common.title || safeName.replace(/\.[^.]+$/, ''),
    artist: parsed.common.artist || 'Unknown Artist',
    album: parsed.common.album,
    duration,
    durationEstimated,
    pictureData,
    pictureDataFull,
    pictureFormat,
    bitrate: parsed.format.bitrate ?? undefined,
    size: safeSize,
    v: 9,
  };

  const existingMem = metadataCache[fileId];
  if (existingMem) {
    entry.dbId = entry.dbId ?? existingMem.dbId;
    entry.coverUrl = entry.coverUrl ?? existingMem.coverUrl;
    entry.fullCoverUrl = entry.fullCoverUrl ?? existingMem.fullCoverUrl;
  }
  setMetadataCache(fileId, entry);
  setCache(`metadata_${fileId}`, entry, true).catch(e => console.warn(`[${META_MODULE}] cache-set-failed`, classifyMetaError(e)));
  return entry;
  }, _signal);
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
