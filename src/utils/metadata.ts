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
}

async function compressImage(data: Uint8Array, mimeType: string): Promise<{data: Uint8Array, format: string} | null> {
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
const metadataQueue: (() => void)[] = [];
let activeMetadataCount = 0;
const MAX_METADATA_CONCURRENT = 5;

async function acquireMetadataLock() {
  if (activeMetadataCount < MAX_METADATA_CONCURRENT) {
    activeMetadataCount++;
    return;
  }
  return new Promise<void>(resolve => {
    metadataQueue.push(resolve);
  });
}

function releaseMetadataLock() {
  if (metadataQueue.length > 0) {
    const next = metadataQueue.shift();
    if (next) next();
  } else {
    activeMetadataCount--;
  }
}

const metadataCache: Record<string, CachedMetadata> = {};


export async function getTrackMetadata(fileId: string, streamUrlOrToken?: string, knownSize?: number, knownName?: string): Promise<CachedMetadata> {
  if (metadataCache[fileId]) return metadataCache[fileId];
  
  const cacheKey = `metadata_${fileId}`;
  
  try {
    const cached = await get<CachedMetadata>(cacheKey);
    if (cached && cached.size !== undefined && cached.duration !== undefined && cached.v === 5) {
      metadataCache[fileId] = cached;
      return cached;
    }
  } catch (e) {
    console.warn("Cache read error", e);
  }

  await acquireMetadataLock();
  
  try {
    if (knownSize && knownName) {
      try {
        const localMeta = await invoke<{title: string, artist: string, album: string, duration: number, has_cover: boolean, file_type: string} | null>("get_local_metadata", {
          size: knownSize,
          name: knownName,
        });
        
        if (localMeta) {
          const result: CachedMetadata = {
            title: localMeta.title,
            artist: localMeta.artist,
            duration: localMeta.duration,
            size: knownSize,
            fileType: localMeta.file_type,
            coverUrl: localMeta.has_cover ? `http://127.0.0.1:3457/cover?size=${knownSize}&thumb=true` : undefined,
            fullCoverUrl: localMeta.has_cover ? `http://127.0.0.1:3457/cover?size=${knownSize}` : undefined,
            v: 5
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
        const proxyUrl = `http://127.0.0.1:3457/stream.mp3?id=${fileId}&token=${streamUrlOrToken}`;
        const response = await fetch(proxyUrl, { headers: fetchHeaders });
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
              headers: { 'Authorization': `Bearer ${streamUrlOrToken}` }
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
        const buffer = await response.arrayBuffer();
        const fileInfo = { mimeType: 'audio/mpeg', size: fileSize };
        metadata = await musicMetadata.parseBuffer(new Uint8Array(buffer), fileInfo, { duration: true });
      } else {
        metadata = await musicMetadata.fetchFromUrl(streamUrlOrToken);
      }
    } catch (e) {
      console.warn("Metadata fetch error:", e);
      const defaultResult: CachedMetadata = { title: knownName || "Unknown Track", v: 3 };
      metadataCache[fileId] = defaultResult;
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
      v: 7, // Network fallback gets v: 7 so it can be overwritten if DB becomes available
    };
    
    const picture = metadata.common.picture?.[0];
    if (picture) {
      const compressed = await compressImage(picture.data, picture.format);
      if (compressed) {
        finalResult.pictureData = compressed.data;
        finalResult.pictureFormat = compressed.format;
      } else {
        finalResult.pictureData = picture.data;
        finalResult.pictureFormat = picture.format;
      }
    }
    
    metadataCache[fileId] = finalResult;
    await set(cacheKey, finalResult);
    window.dispatchEvent(new CustomEvent('metadata-updated', { detail: { fileId } }));
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
      // Only update if difference is > 1 second
      if (Math.abs((cached.duration || 0) - accurateDuration) > 1) {
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
