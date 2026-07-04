import * as musicMetadata from 'music-metadata-browser';
import { get, set } from 'idb-keyval';
import { invoke } from "@tauri-apps/api/core";

export interface CachedMetadata {
  title?: string;
  artist?: string;
  pictureData?: Uint8Array;
  pictureFormat?: string;
  coverUrl?: string;
  fullCoverUrl?: string;
  fileType?: string;
  bitrate?: number;
  duration?: number;
  size?: number;
  v?: number;
  mimeType?: string;
  dbId?: string;
}

let _proxyPort: number | null = null;
async function getProxyPort(): Promise<number> {
  if (_proxyPort !== null) return _proxyPort;
  try {
    _proxyPort = await invoke<number>("get_proxy_port");
    if (_proxyPort === 0) _proxyPort = 3457;
  } catch (e) {
    _proxyPort = 3457;
  }
  return _proxyPort;
}

async function compressImage(data: Uint8Array, mimeType: string): Promise<{ data: Uint8Array, format: string } | null> {
  try {
    const blob = new Blob([new Uint8Array(data)], { type: mimeType });
    const bitmap = await createImageBitmap(blob);

    const MAX = 256;
    let width = bitmap.width;
    let height = bitmap.height;

    if (width > MAX || height > MAX) {
      if (width > height) {
        height = Math.round(height * MAX / width);
        width = MAX;
      } else {
        width = Math.round(width * MAX / height);
        height = MAX;
      }
    }

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, width, height);
        const compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
        const buffer = await compressedBlob.arrayBuffer();
        return { data: new Uint8Array(buffer), format: 'image/jpeg' };
      }
    } else if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, width, height);
        return new Promise((resolve) => {
          canvas.toBlob((compressedBlob) => {
            if (compressedBlob) {
              compressedBlob.arrayBuffer().then(buffer => {
                resolve({ data: new Uint8Array(buffer), format: 'image/jpeg' });
              });
            } else resolve(null);
          }, 'image/jpeg', 0.7);
        });
      }
    }
  } catch (e) {
    console.warn("Image compression failed", e);
  }
  return null;
}

// Concurrency queue to prevent IPC/Network flooding when loading 1000 tracks
const metadataQueue: ((acquired: boolean) => void)[] = [];
let activeMetadataCount = 0;
const MAX_METADATA_CONCURRENT = 5;

async function acquireMetadataLock(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;

  if (activeMetadataCount < MAX_METADATA_CONCURRENT) {
    activeMetadataCount++;
    return true;
  }
  
  return new Promise<boolean>(resolve => {
    let resolveFn: (acquired: boolean) => void;
    
    const onAbort = () => {
      const index = metadataQueue.indexOf(resolveFn);
      if (index !== -1) {
        metadataQueue.splice(index, 1);
      }
      resolve(false);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    resolveFn = (acquired: boolean) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        if (acquired) releaseMetadataLock();
        resolve(false);
      } else {
        if (!acquired) activeMetadataCount++;
        resolve(true);
      }
    };
    
    metadataQueue.push(resolveFn);
  });
}

function releaseMetadataLock() {
  if (metadataQueue.length > 0) {
    const next = metadataQueue.shift();
    if (next) next(true);
  } else {
    activeMetadataCount--;
  }
}

export const metadataCache: Record<string, CachedMetadata> = {};
const metadataCacheKeys: string[] = [];
const MAX_CACHE_SIZE = 50;

export async function getTrackMetadata(fileId: string, streamUrlOrToken?: string, knownSize?: number, knownName?: string, signal?: AbortSignal): Promise<CachedMetadata> {
  if (metadataCache[fileId]) {
    // Move to end (LRU)
    const idx = metadataCacheKeys.indexOf(fileId);
    if (idx !== -1) {
      metadataCacheKeys.splice(idx, 1);
      metadataCacheKeys.push(fileId);
    }
    return metadataCache[fileId];
  }

  const cacheKey = `metadata_${fileId}`;

  try {
    const cached = await get<CachedMetadata>(cacheKey);
    if (cached && cached.size !== undefined && cached.duration !== undefined && cached.v === 10) {
      if (cached.coverUrl && cached.coverUrl.includes('127.0.0.1')) {
        const port = await getProxyPort();
        cached.coverUrl = `http://127.0.0.1:${port}/cover?id=${cached.dbId || fileId}&thumb=true`;
        cached.fullCoverUrl = `http://127.0.0.1:${port}/cover?id=${cached.dbId || fileId}`;
      }
      metadataCache[fileId] = cached;
      metadataCacheKeys.push(fileId);
      if (metadataCacheKeys.length > MAX_CACHE_SIZE) {
        const oldestKey = metadataCacheKeys.shift();
        if (oldestKey) delete metadataCache[oldestKey];
      }
      return cached;
    }
  } catch (e) {
    console.warn("Cache read error", e);
  }

  const acquired = await acquireMetadataLock(signal);
  if (!acquired) {
    throw new DOMException('Aborted', 'AbortError');
  }

  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (knownSize) {
      try {
        const localMeta = await invoke<{ id: string, title: string, artist: string, album: string, duration: number, has_cover: boolean, file_type: string } | null>("get_local_metadata", {
          size: Number(knownSize),
          name: knownName || "",
        });

        if (localMeta) {
          const port = await getProxyPort();
          const result: CachedMetadata = {
            title: localMeta.title,
            artist: localMeta.artist,
            duration: localMeta.duration,
            size: knownSize,
            fileType: localMeta.file_type,
            dbId: localMeta.id,
            coverUrl: localMeta.has_cover ? `http://127.0.0.1:${port}/cover?id=${localMeta.id}&thumb=true` : undefined,
            fullCoverUrl: localMeta.has_cover ? `http://127.0.0.1:${port}/cover?id=${localMeta.id}` : undefined,
            v: 10
          };
          await set(cacheKey, result);
          metadataCache[fileId] = result;
          return result;
        }
      } catch (e) {
        console.error("Local metadata fetch error:", e);
      }
    }

    if (!streamUrlOrToken) {
      const defaultResult: CachedMetadata = { title: knownName || "Unknown Track", v: 3 };
      metadataCache[fileId] = defaultResult;
      return defaultResult;
    }

    let fileSizeExtracted: number | undefined;
    let metadata;
    let buffer: ArrayBuffer | null = null;

    try {
      if (!streamUrlOrToken.startsWith('http')) {
        const scanMode = (await get("drplay_scan_mode")) || 'fast';
        const fetchHeaders: HeadersInit = {};

        if (scanMode === 'fast') {
          fetchHeaders['Range'] = 'bytes=0-65535';
        }

        // CRITICAL FIX: Use local proxy instead of direct Google Drive URL.
        // Google Drive CORS strips Range headers in browsers, causing WebView2 to download
        // the ENTIRE 3GB FILE directly into RAM (response.arrayBuffer()) just to read 64KB of ID3 tags!
        const port = await getProxyPort();
        const proxyUrl = `http://127.0.0.1:${port}/stream.mp3?id=${fileId}`;
        const response = await fetch(proxyUrl, { headers: fetchHeaders, signal });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const contentRange = response.headers.get('content-range');
        let fileSize;
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)/);
          if (match) fileSize = parseInt(match[1], 10);
        }

        if (!fileSize) {
          try {
            const metaResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, {
              headers: { 'Authorization': `Bearer ${streamUrlOrToken}` },
              signal
            });
            if (metaResponse.ok) {
              const metaData = await metaResponse.json();
              if (metaData.size) fileSize = parseInt(metaData.size, 10);
            }
          } catch (e) {
            console.warn("Failed to fetch size fallback", e);
          }
        }

        fileSizeExtracted = fileSize;
        buffer = await response.arrayBuffer();
        const fileInfo = { mimeType: 'audio/mpeg', size: fileSize };
        metadata = await musicMetadata.parseBuffer(new Uint8Array(buffer), fileInfo, { duration: true });
      } else {
        metadata = await musicMetadata.fetchFromUrl(streamUrlOrToken);
      }
    } catch (e: any) {
      if (e.name === 'AbortError') throw e;
      console.warn("Metadata fetch error:", e);
      const defaultResult: CachedMetadata = { title: knownName || "Unknown Track", v: 3 };
      metadataCache[fileId] = defaultResult;
      metadataCacheKeys.push(fileId);
      if (metadataCacheKeys.length > MAX_CACHE_SIZE) {
        const oldestKey = metadataCacheKeys.shift();
        if (oldestKey) delete metadataCache[oldestKey];
      }
      return defaultResult;
    }

    let finalDuration = metadata?.format?.duration;
    let actualBitrate = metadata?.format?.bitrate;
    let estimatedBitrate = actualBitrate;

    if (!estimatedBitrate && fileSizeExtracted) {
      estimatedBitrate = 128000;
    }

    if ((!finalDuration || finalDuration < 10) && fileSizeExtracted && estimatedBitrate) {
      finalDuration = (fileSizeExtracted * 8) / estimatedBitrate;
    }

    const finalResult: CachedMetadata = {
      title: metadata?.common?.title,
      artist: metadata?.common?.artist,
      duration: finalDuration,
      size: fileSizeExtracted,
      bitrate: actualBitrate,
      mimeType: (metadata?.format as any)?.mimeType,
      v: 9, // Network fallback gets v: 9
    };

    const picture = metadata.common.picture?.[0];
    if (picture) {
      const compressed = await compressImage(picture.data, picture.format);
      if (compressed) {
        finalResult.pictureData = compressed.data;
        finalResult.pictureFormat = compressed.format;
      } else {
        // Must make a hard copy because we might detach the original buffer!
        finalResult.pictureData = new Uint8Array(picture.data);
        finalResult.pictureFormat = picture.format;
      }
    }

    metadataCache[fileId] = finalResult;
    metadataCacheKeys.push(fileId);
    if (metadataCacheKeys.length > MAX_CACHE_SIZE) {
      const oldestKey = metadataCacheKeys.shift();
      if (oldestKey) delete metadataCache[oldestKey];
    }
    
    await set(cacheKey, finalResult);
    window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId } }));
    
    // Detach ArrayBuffer and cleanup metadata right before returning
    if (buffer) {
      try {
        const { port1 } = new MessageChannel();
        port1.postMessage(buffer, [buffer]);
      } catch (err) {}
    }
    buffer = null;
    if (metadata?.common?.picture) metadata.common.picture = [];
    metadata = null;
    
    return finalResult;
  } finally {
    releaseMetadataLock();
  }
}

export async function updateTrackDuration(fileId: string, accurateDuration: number) {
  const cacheKey = `metadata_${fileId}`;
  try {
    const cached = await get<CachedMetadata>(cacheKey);
    if (cached) {
      const oldDuration = cached.duration || 0;
      // Only update if difference is > 1 second
      if (Math.abs(oldDuration - accurateDuration) > 1) {
        // Prevent writing truncated durations caused by network interrupts (e.g. 5 mins for a 3 hr file)
        if (oldDuration > 0 && accurateDuration < oldDuration * 0.8) {
          console.warn(`Ignoring suspiciously short duration update for ${fileId}: ${accurateDuration}s vs old ${oldDuration}s`);
          return;
        }

        cached.duration = accurateDuration;
        await set(cacheKey, cached);
        // Dispatch event to update SongCard immediately
        window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId } }));
      }
    }
  } catch (e) {
    console.warn("Failed to update accurate track duration", e);
  }
}
