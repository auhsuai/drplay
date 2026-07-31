import { db } from '../db/db';
import { getTrackMetadata } from '../utils/metadata';
import { getAudioFilesQuery } from '../utils/audioQuery';
import { classifyWorkerError, logWorkerError } from './workerError';

interface DriveFileItem { id: string; name?: string; mimeType?: string; size?: string; parents?: string[]; md5Checksum?: string; createdTime?: string; modifiedTime?: string; trashed?: boolean; }

// Limit to 20 concurrent threads to maximize scan speed
const MAX_CONCURRENT = 20;
const SCANNER_FETCH_TIMEOUT_MS = 30000;

// Listen for messages from the main thread
self.addEventListener('message', async (e: MessageEvent) => {
  const { token } = e.data;
  if (!token) return;

  await startScanner(token);
});

async function startScanner(token: string) {
  let pageToken: string | undefined = undefined;

  // A Set is mutated in place, so concurrent `.finally()` deletions can never
  // race each other the way array reassignment could (stale snapshot overwrite).
  const activePromises = new Set<Promise<void>>();

  const processFile = async (file: { id: string; size?: string; name?: string }) => {
    const fileId = file.id;
    const cacheKey = `metadata_${fileId}`;
    try {
      // Skip if file metadata is already fully parsed and cached.
      const row = await db.metadataCache.get(cacheKey);
      const cached = row?.entry as { version: number; data?: { v?: number }; ts: number } | undefined;
      if (cached && cached.data && (cached.data.v ?? 0) >= 9) return;
    } catch (err) {
      // Cache read failed: treat as a cache miss and keep scanning this file
      // rather than dropping it. The metadata fetch below is the source of truth.
      logWorkerError('scanner/cache', { fileId }, err, 'warn');
    }

    const parsedSize = file.size ? parseInt(file.size, 10) : undefined;
    const knownSize = Number.isFinite(parsedSize) ? parsedSize : undefined;
    try {
      await getTrackMetadata(fileId, token, knownSize, file.name);
    } catch (err) {
      // Isolate per-file failure: one corrupt/timed-out file must not abort the
      // whole scan. We log with context and continue.
      logWorkerError('scanner/metadata', { fileId }, err, 'warn');
    }
  };

  do {
    try {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.append('q', getAudioFilesQuery());
      url.searchParams.append('fields', 'nextPageToken,files(id, size, name)');
      url.searchParams.append('pageSize', '1000'); // Fetch max 1000 files per page
      if (pageToken) url.searchParams.append('pageToken', pageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SCANNER_FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        logWorkerError('scanner/list', { status: res.status }, new Error(`Drive list request failed (${res.status})`), 'warn');
        break;
      }

      let data: { files?: DriveFileItem[]; nextPageToken?: string };
      try {
        data = await res.json();
      } catch (err) {
        // Body was not valid JSON: do not blindly continue, stop the scan and
        // report a parse failure instead of swallowing it.
        logWorkerError('scanner/list-parse', { status: res.status }, err, 'error');
        break;
      }

      const files = data.files || [];

      for (const file of files) {
        const p = processFile(file).finally(() => {
          activePromises.delete(p);
        });
        activePromises.add(p);

        // If running threads reach the limit, wait for one to finish
        if (activePromises.size >= MAX_CONCURRENT) {
          await Promise.race(activePromises);

          // YIELD MECHANISM:
          // Allow the worker's event loop to breathe, process pending messages,
          // and run Garbage Collection before the next heavy parse cycle.
          const sched = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }).scheduler;
          if (sched?.yield) {
            await sched.yield();
          } else {
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }

      pageToken = data.nextPageToken;
    } catch (err) {
      const kind = classifyWorkerError(err);
      // A timeout/abort means the list page will never arrive — stop cleanly.
      // Network errors are transient but we cannot resume a partial page, so we
      // stop and let the next scan pass retry from where Drive's cursor left off.
      logWorkerError('scanner/list', { kind }, err, kind === 'abort' ? 'warn' : 'error');
      break;
    }
  } while (pageToken);

  // Wait for the last remaining threads to complete
  await Promise.allSettled(activePromises);
}
