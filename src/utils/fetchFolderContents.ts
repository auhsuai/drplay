import { db } from '../db/db';
import { driveFetch } from './driveApi';
import { getFolderAudioQuery } from './audioQuery';
import { captureError } from './errorLog';

const APP_MODULE = 'App';

// Derive a short, safe classification tag from an error's message ONLY.
// We never log the error object or its stack — those can leak file ids, user
// data, or (in theory) auth material into logs.
function classifyError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown-error";
  const m = msg.toLowerCase();
  if (m.includes("timeout") || m.includes("aborterror")) return "timeout";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("unreachable"))
    return "network";
  const statusMatch = m.match(/\((\d{3})\)/);
  if (statusMatch) return `http-${statusMatch[1]}`;
  return "unknown";
}

export type FolderFetchCleanup = () => void;

export async function fetchFolderContents(
  token: string,
  folderId: string,
  sortOption: string,
  onStart: () => void,
  onDone: () => void,
): Promise<void> {
  let fetchCompleted = true;
  const fetchStartedAt = performance.now();
  let pageCount = 0;
  let fetchMs = 0;
  let parseMs = 0;
  let bulkPutMs = 0;
  let deleteSyncMs = 0;

  try {
    const existingCount = await db.files.where('parentId').equals(folderId).count();
    if (existingCount === 0) onStart();

    const q = getFolderAudioQuery(folderId);

    const driveOrderBy = (() => {
      switch (sortOption) {
        case 'name desc': return 'folder,name_natural desc';
        case 'modifiedTime': return 'folder,modifiedTime';
        case 'modifiedTime desc': return 'folder,modifiedTime desc';
        case 'size': return 'folder,quotaBytesUsed';
        case 'size desc': return 'folder,quotaBytesUsed desc';
        case 'name':
        default: return 'folder,name_natural';
      }
    })();

    let pageToken: string | undefined;
    let allFiles: any[] = [];
    let laterPagesFiles: any[] = [];
    let isFirstPage = true;

    do {
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent(driveOrderBy)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)&pageSize=1000` + (pageToken ? `&pageToken=${pageToken}` : '');
      const fetchPhaseStart = performance.now();
      const response = await driveFetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchMs += performance.now() - fetchPhaseStart;

      if (!response.ok) {
        console.error(`[${APP_MODULE}] Failed to fetch page from drive API`, response.status);
        fetchCompleted = false;
        captureError({
          level: 'error',
          source: 'App/fetchFolderContentsToDexie',
          message: `Drive API page fetch failed: HTTP ${response.status} after ${pageCount} successful page(s) and ${Math.round(performance.now() - fetchStartedAt)}ms elapsed (folder had ${allFiles.length} file(s) fetched so far)`,
          kind: `http-${response.status}`,
        });
        break;
      }

      const parsePhaseStart = performance.now();
      const data = await response.json();
      parseMs += performance.now() - parsePhaseStart;

      if (data.files && data.files.length > 0) {
        const filesToInsert = data.files.map((file: any) => ({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          parentId: folderId,
          size: (() => {
            const parsed = file.size ? parseInt(file.size, 10) : NaN;
            return Number.isFinite(parsed) ? parsed : undefined;
          })(),
          modifiedTime: file.modifiedTime,
          trashed: false,
          isFolder: file.mimeType === "application/vnd.google-apps.folder"
        }));

        if (isFirstPage) {
          const bulkPutPhaseStart = performance.now();
          await db.files.bulkPut(filesToInsert);
          bulkPutMs += performance.now() - bulkPutPhaseStart;
        } else {
          laterPagesFiles = laterPagesFiles.concat(filesToInsert);
        }
        allFiles = allFiles.concat(filesToInsert);
      }

      pageToken = data.nextPageToken;
      pageCount++;

      if (isFirstPage && pageToken && existingCount === 0) {
        onDone();
      }
      isFirstPage = false;
    } while (pageToken);

    if (laterPagesFiles.length > 0) {
      const laterBulkPutStart = performance.now();
      await db.files.bulkPut(laterPagesFiles);
      bulkPutMs += performance.now() - laterBulkPutStart;
    }

    if (fetchCompleted && !pageToken) {
      const deleteSyncStart = performance.now();
      const fetchedIds = new Set(allFiles.map((f: any) => f.id));
      const localFiles = await db.files.where('parentId').equals(folderId).toArray();
      const idsToDelete = localFiles.filter(f => !fetchedIds.has(f.id)).map(f => f.id);
      if (idsToDelete.length > 0) await db.files.bulkDelete(idsToDelete);
      deleteSyncMs += performance.now() - deleteSyncStart;
    }
  } catch (error) {
    const classification = classifyError(error);
    console.error(`[${APP_MODULE}] Failed to fetch folder contents on demand:`, classification);
    fetchCompleted = false;
    captureError({
      level: 'error',
      source: 'App/fetchFolderContentsToDexie',
      message: `Folder fetch threw after ${pageCount} successful page(s) and ${Math.round(performance.now() - fetchStartedAt)}ms: ${classification}`,
      kind: 'exception',
    });
  } finally {
    const elapsedMs = Math.round(performance.now() - fetchStartedAt);
    if (elapsedMs > 2000) {
      const otherMs = Math.max(0, elapsedMs - Math.round(fetchMs) - Math.round(parseMs) - Math.round(bulkPutMs) - Math.round(deleteSyncMs));
      captureError({
        level: 'warn',
        source: 'App/fetchFolderContentsToDexie',
        message: `Folder load took ${elapsedMs}ms across ${pageCount} Drive API page(s) for folder ${folderId} -- breakdown: driveFetch=${Math.round(fetchMs)}ms, json-parse=${Math.round(parseMs)}ms, dexie-bulkPut=${Math.round(bulkPutMs)}ms, delete-sync=${Math.round(deleteSyncMs)}ms, other/overhead=${otherMs}ms`,
        kind: 'slow-load',
      });
    }
    onDone();
  }
}
