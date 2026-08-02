import { t } from 'i18next';
import { db } from '../db/db';
import type { DriveFile } from '../db/db';
import { createFolder, getDriveStorageQuota, uploadFileResumable, uploadFileResumableChunked, UploadError } from './driveApi';
import type { DriveFileItem, DriveStorageQuota } from './driveApi';
import { openDiskReadStream, registerUploadPath, statDiskPath, walkDiskFolder } from './diskFs';
import type { DiskEntry } from './diskFs';
import { captureError } from './errorLog';
import { basename } from './pathUtils';
import { showErrorToast } from './simpleToast';

// Sequential queue (1 upload at a time) + pending db.files rows that render as
// dimmed cards; CustomEvents drive cards, race guards, Recently Added refresh.
const MODULE = 'uploadManager';
const PENDING_ID_PREFIX = 'pending-';
// Drive folders report this mimeType; octet-stream uploads keep it (getFolderAudioQuery matches on it).
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_FILE_MIME = 'application/octet-stream';
// 1 attempt + 2 retries; backoff (attempt-1) = 1s, 3s.
const MAX_UPLOAD_ATTEMPTS = 3;
const RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 3000];
const ROOT_PARENT_ID = 'root';
const UPLOAD_STATUS_EVENT = 'upload-status-changed';
const DRIVE_FILES_CHANGED_EVENT = 'drive-files-changed';
const ERROR_INVALID_SEED = 'invalid-seed';
const ERROR_QUOTA = 'quota';
const ERROR_PARENT_FOLDER_MISSING = 'parent-folder-missing';
const ERROR_FAILED = 'failed';

export interface UploadEntry {
  id: string; // 'pending-<uuid>' until a real Drive id exists (also db.files row id)
  name: string;
  isFolder: boolean;
  parentId: string; // Drive destination folder ('root' is valid)
  diskPath?: string;
  bytes?: Blob | Uint8Array;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string; // only when status === 'error'
  progress?: number; // 0..1 fraction of bytes confirmed by Drive (chunked disk uploads)
}

export interface UploadSeed {
  name: string;
  isFolder: boolean;
  parentId: string;
  diskPath?: string;
  bytes?: Blob | Uint8Array;
}

type UploadKind = 'bytes' | 'diskFile' | 'folderRoot' | 'folderChild' | 'folderChildFile';

// Internal fields (token, attempt, memo, drive id) must never leak through the public contract.
interface InternalEntry extends UploadEntry {
  token: string;
  kind: UploadKind;
  driveId?: string;
  attempt: number;
  relativeDir?: string; // dir path within a folder batch ('sub/sub2'; '' = batch root)
  batchMemo?: Map<string, string>; // shared per batch: relativeDir -> driveId ('' marker = enqueued)
}

interface FolderBatch {
  entry: InternalEntry;
  memo: Map<string, string>;
}

class ParentFolderMissingError extends Error {
  constructor(relativeDir: string) {
    super(`parent folder not created: ${relativeDir}`);
    this.name = 'ParentFolderMissingError';
  }
}

let entries: InternalEntry[] = [];
let busy = false;
const subscribers = new Set<() => void>();

// Terminal (done/error) entries are useless to the UI — getUploadingIds /
// getUploadState only read queued/uploading — but each holds a full diskPath
// string and (for byte seeds) the raw payload, so keeping them is an
// unbounded retention that grows with every batch. Callers must have fired
// their final notify() first so subscribers still observe the terminal state.
function pruneEntry(entry: InternalEntry): void {
  entry.bytes = undefined;
  entries = entries.filter((e) => e !== entry);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

export function startUploads(seeds: UploadSeed[], token: string): void {
  for (const seed of seeds) {
    entries.push(createEntry(seed, token));
  }
  notify();
  void pump();
}

export function getUploadingIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== 'queued' && entry.status !== 'uploading') continue;
    ids.add(entry.id);
    if (entry.driveId) ids.add(entry.driveId);
    // The parent folder must stay locked (spinner, no dim) while a child uploads.
    if (entry.parentId !== ROOT_PARENT_ID) ids.add(entry.parentId);
  }
  return ids; // fresh set per call - callers must not cache the reference
}

export function isUploading(id: string): boolean {
  return getUploadingIds().has(id);
}

// Card-level upload presentation state (slice 6):
// - 'uploading'        → the item itself is being uploaded (dim + spinner)
// - 'parent-uploading' → a child of this folder is uploading (spinner only,
//                        the folder already exists on Drive — no dim)
// - 'none'             → idle
export type UploadState = 'none' | 'uploading' | 'parent-uploading';

export function getUploadState(id: string): UploadState {
  // Mirrors getUploadingIds' coverage (entry id + driveId + parentId) but
  // resolves a SINGLE id to a presentation state instead of a flat set.
  // 'uploading' wins when the id matches both (e.g. a folder whose own
  // driveId matches while a child uploads under it).
  let isParent = false;
  for (const entry of entries) {
    if (entry.status !== 'queued' && entry.status !== 'uploading') continue;
    if (entry.id === id || entry.driveId === id) return 'uploading';
    if (entry.parentId === id && id !== ROOT_PARENT_ID) isParent = true;
  }
  return isParent ? 'parent-uploading' : 'none';
}

export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
export function getEntries(): UploadEntry[] {
  return entries.map((e) => ({
    id: e.id, name: e.name, isFolder: e.isFolder, parentId: e.parentId,
    status: e.status, diskPath: e.diskPath, bytes: e.bytes, error: e.error,
    progress: e.progress,
  }));
}

// Fire subscribers + window event; a throwing subscriber must not break the loop.
function notify(): void {
  for (const cb of subscribers) {
    try {
      cb();
    } catch (err) {
      captureError({ level: 'warn', source: MODULE, message: `subscriber-failed: ${describeError(err)}` });
    }
  }
  window.dispatchEvent(new CustomEvent<UploadEntry[]>(UPLOAD_STATUS_EVENT, { detail: getEntries() }));
}
function createEntry(seed: UploadSeed, token: string): InternalEntry {
  const entry: InternalEntry = {
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: seed.name, isFolder: seed.isFolder, parentId: seed.parentId,
    diskPath: seed.diskPath, bytes: seed.bytes,
    status: 'queued', token,
    kind: seed.isFolder ? 'folderRoot' : seed.diskPath ? 'diskFile' : 'bytes',
    attempt: 0,
  };
  if (seed.isFolder && !seed.diskPath) {
    failSeed(entry, 'folder seed lacks a disk path');
  } else if (!seed.isFolder && !seed.bytes && !seed.diskPath) {
    failSeed(entry, 'file seed lacks both bytes and a disk path');
  }
  return entry;
}

// Invalid seeds error synchronously (never enqueued) and surface as error entries.
function failSeed(entry: InternalEntry, reason: string): void {
  entry.status = 'error';
  entry.error = ERROR_INVALID_SEED;
  captureError({ level: 'warn', source: MODULE, message: `invalid-seed name=${entry.name}: ${reason}` });
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const next = entries.find((e) => e.status === 'queued');
      if (!next) break;
      await processEntry(next);
    }
  } finally {
    busy = false;
  }
}

async function processEntry(entry: InternalEntry): Promise<void> {
  entry.status = 'uploading';
  notify();
  await dbRowOp(
    () => db.files.put({
      id: entry.id, name: entry.name,
      mimeType: entry.isFolder ? FOLDER_MIME : AUDIO_FILE_MIME,
      parentId: entry.parentId, trashed: false, isFolder: entry.isFolder,
      modifiedTime: new Date().toISOString(),
    }),
    'pending-row'
  );
  try {
    const driveItem = await handleByKind(entry);
    await markDone(entry, driveItem);
  } catch (err) {
    await markError(entry, err);
  }
}

function handleByKind(entry: InternalEntry): Promise<DriveFileItem> {
  switch (entry.kind) {
    case 'bytes': {
      if (!entry.bytes) throw new UploadError('missing upload bytes', 'invalid');
      return uploadWithQuotaAndRetry(entry, entry.bytes);
    }
    case 'diskFile':
      return handleDiskFile(entry);
    case 'folderChildFile':
      return handleChildFile(entry);
    case 'folderRoot':
      return handleFolderRoot(entry);
    case 'folderChild':
      return handleFolderChild(entry);
  }
}

async function handleDiskFile(entry: InternalEntry): Promise<DriveFileItem> {
  const path = entry.diskPath;
  if (!path) throw new UploadError('missing disk path', 'invalid');
  entry.name = basename(path);
  await registerUploadPath(path);
  return uploadDiskFileStreaming(entry, path);
}

async function handleChildFile(entry: InternalEntry): Promise<DriveFileItem> {
  // The parent's drive id is only known once its own folder entry completed
  // (the queue is sequential, so it always has by the time a child runs).
  const dir = entry.relativeDir ?? '';
  const parentId = entry.batchMemo?.get(dir);
  if (!parentId) throw new ParentFolderMissingError(dir);
  entry.parentId = parentId;
  const path = entry.diskPath;
  if (!path) throw new UploadError('missing disk path', 'invalid');
  return uploadDiskFileStreaming(entry, path);
}

// Disk-path files stream in bounded chunks (~8 MiB in memory) instead of
// materializing the whole file in the JS heap — the fix for the multi-GB RAM
// spike when uploading large FLAC/WAV files. The file size comes from one stat
// (walk entries carry size 0), which also feeds the quota check.
async function uploadDiskFileStreaming(entry: InternalEntry, path: string): Promise<DriveFileItem> {
  const stat = await statDiskPath(path);
  if (stat === null || stat.isDirectory) {
    // Plain Error (not UploadError) so the entry shows 'failed', same as the
    // old whole-file read failure.
    throw new Error(`file not found on disk: ${basename(path)}`);
  }
  if (!(await quotaAllows(entry, stat.size))) {
    throw new UploadError('drive storage quota exceeded', 'quota');
  }
  return uploadDiskPathChunked(entry, path, stat.size);
}

async function uploadDiskPathChunked(entry: InternalEntry, path: string, totalSize: number): Promise<DriveFileItem> {
  let stream = await openDiskReadStream(path);
  let consumed = 0;
  const readChunk = async (offset: number): Promise<Uint8Array | null> => {
    if (offset < consumed) {
      // A 308 resume can ask for bytes we already consumed (server received
      // fewer than sent). The rid-backed handle only reads forward, so reopen
      // the stream and skip to the requested offset.
      await stream.close();
      stream = await openDiskReadStream(path);
      consumed = 0;
    }
    while (consumed < offset) {
      const skipped = await stream.read();
      if (skipped === null) break;
      consumed += skipped.byteLength;
    }
    const chunk = await stream.read();
    if (chunk === null) return null;
    consumed += chunk.byteLength;
    return chunk;
  };
  try {
    return await uploadFileResumableChunked(entry.token, {
      name: entry.name,
      parentId: entry.parentId,
      totalSize,
      readChunk,
      // Progress is written silently on the entry — no notify() per chunk
      // (subscribers re-render on status changes only; per-chunk notifies
      // would spam the UI on a 1 GB file = 128 chunks).
      onProgress: (fraction) => {
        entry.progress = fraction;
      },
    });
  } finally {
    await stream.close();
  }
}

async function handleFolderChild(entry: InternalEntry): Promise<DriveFileItem> {
  // A subfolder's parent is the dir ABOVE it ('sub' -> batch root;
  // 'sub/sub2' -> 'sub'), resolved via the batch memo.
  const parentDir = dirOf(entry.relativeDir ?? '');
  const parentId = entry.batchMemo?.get(parentDir);
  if (!parentId) throw new ParentFolderMissingError(parentDir);
  entry.parentId = parentId;
  return createFolder(entry.token, entry.name, entry.parentId);
}

async function handleFolderRoot(entry: InternalEntry): Promise<DriveFileItem> {
  const dirPath = entry.diskPath;
  if (!dirPath) throw new UploadError('missing disk path', 'invalid');
  await registerUploadPath(dirPath);
  const walked = await walkDiskFolder(dirPath);
  const rootFolder = await createFolder(entry.token, entry.name, entry.parentId);
  const memo = new Map<string, string>();
  memo.set('', rootFolder.id);
  const batch: FolderBatch = { entry, memo };
  // walkDiskFolder sorts by relativePath, so a folder's entry (and thus its
  // creation) always precedes the files inside it - the sequential queue
  // preserves that order and the memo is filled before children resolve it.
  for (const item of walked) {
    if (item.isDirectory) {
      if (!memo.has(item.relativePath)) enqueueFolderChild(batch, item.relativePath);
    } else {
      ensureSubfolderChain(batch, item.relativePath);
      enqueueChildFile(batch, item);
    }
  }
  return rootFolder;
}

// One folder entry per distinct subfolder (memo dedupes), even if walk omits dirs.
function ensureSubfolderChain(batch: FolderBatch, relPath: string): void {
  const dir = dirOf(relPath);
  if (!dir) return;
  let acc = '';
  for (const segment of dir.split('/')) {
    acc = acc ? `${acc}/${segment}` : segment;
    if (!batch.memo.has(acc)) {
      enqueueFolderChild(batch, acc);
    }
  }
}

function enqueueFolderChild(batch: FolderBatch, relativeDir: string): void {
  const entry: InternalEntry = {
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: basename(relativeDir), isFolder: true,
    parentId: batch.entry.parentId, // placeholder - resolved during processing
    status: 'queued', token: batch.entry.token, kind: 'folderChild', attempt: 0,
    relativeDir, batchMemo: batch.memo,
  };
  batch.memo.set(relativeDir, ''); // '' marker = enqueued, drive id pending
  entries.push(entry);
}
function enqueueChildFile(batch: FolderBatch, item: DiskEntry): void {
  entries.push({
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: basename(item.relativePath), isFolder: false,
    parentId: batch.entry.parentId, // placeholder - resolved during processing
    diskPath: item.path,
    status: 'queued', token: batch.entry.token, kind: 'folderChildFile', attempt: 0,
    relativeDir: dirOf(item.relativePath), batchMemo: batch.memo,
  });
}

// Bytes-path uploads (picker/tests keep the whole body in memory): quota check
// then uploadFileResumable with manager-level retries. Disk paths bypass this
// and go through uploadDiskFileStreaming — the chunked uploader retries
// transient failures internally (2 sessions × 2 chunk retries), so layering
// the manager retries on top would multiply upload attempts.
async function uploadWithQuotaAndRetry(entry: InternalEntry, data: Blob | Uint8Array): Promise<DriveFileItem> {
  const byteLength = data instanceof Blob ? data.size : data.byteLength;
  if (!(await quotaAllows(entry, byteLength))) {
    throw new UploadError('drive storage quota exceeded', 'quota');
  }
  return uploadWithRetry(entry, data);
}
// Unknown quota (fetch fail / null) must never block: getDriveStorageQuota logs its own warn.
async function quotaAllows(entry: InternalEntry, byteLength: number): Promise<boolean> {
  let quota: DriveStorageQuota | null;
  try {
    quota = await getDriveStorageQuota(entry.token);
  } catch (err) {
    captureError({ level: 'warn', source: MODULE, message: `quota-check-skipped name=${entry.name}: ${describeError(err)}` });
    return true;
  }
  if (quota === null) return true;
  if (quota.limit === null) return true; // unlimited account (pooled Workspace quota)
  return quota.usage + byteLength <= quota.limit;
}

// Only transient network failures are retried (bounded backoff); pending row stays.
async function uploadWithRetry(entry: InternalEntry, data: Blob | Uint8Array): Promise<DriveFileItem> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    entry.attempt = attempt;
    try {
      return await uploadFileResumable(entry.token, data, entry.name, entry.parentId);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof UploadError && err.kind === 'network' && attempt < MAX_UPLOAD_ATTEMPTS;
      if (!retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new UploadError('upload failed', 'network');
}

async function markDone(entry: InternalEntry, driveItem: DriveFileItem): Promise<void> {
  entry.driveId = driveItem.id;
  // Publish the created subfolder to the batch memo so its child files can
  // resolve their parent id when their own turn comes.
  if (entry.kind === 'folderChild' && entry.relativeDir !== undefined && entry.batchMemo) {
    entry.batchMemo.set(entry.relativeDir, driveItem.id);
  }
  await dbRowOp(() => db.files.delete(entry.id), 'pending-row-delete');
  await dbRowOp(() => db.files.put(realRow(entry, driveItem)), 'real-row');
  entry.status = 'done';
  notify();
  window.dispatchEvent(new CustomEvent(DRIVE_FILES_CHANGED_EVENT, { detail: { count: 1 } }));
  pruneEntry(entry);
}

async function markError(entry: InternalEntry, err: unknown): Promise<void> {
  entry.error =
    err instanceof ParentFolderMissingError
      ? ERROR_PARENT_FOLDER_MISSING
      : err instanceof UploadError
        ? err.kind
        : ERROR_FAILED;
  entry.status = 'error';
  await dbRowOp(() => db.files.delete(entry.id), 'pending-row-delete');
  const isQuota = entry.error === ERROR_QUOTA;
  // Never log the disk path or token - only the shortened file name.
  captureError({
    level: isQuota ? 'warn' : 'error',
    source: MODULE,
    message: `upload-entry-failed name=${entry.name} kind=${entry.error}`,
    kind: entry.error,
  });
  if (isQuota) {
    showErrorToast(t('upload.quota_exceeded'));
  } else if (entry.error !== ERROR_INVALID_SEED && entry.error !== ERROR_PARENT_FOLDER_MISSING) {
    showErrorToast(t('upload.error'));
  }
  notify();
  pruneEntry(entry);
}

function realRow(entry: InternalEntry, driveItem: DriveFileItem): DriveFile {
  let size: number | undefined;
  if (driveItem.size !== undefined) {
    const n = Number(driveItem.size);
    size = Number.isFinite(n) ? n : undefined;
  }
  return {
    id: driveItem.id, name: entry.name,
    mimeType: entry.isFolder ? FOLDER_MIME : driveItem.mimeType,
    parentId: entry.parentId, size,
    trashed: false, isFolder: entry.isFolder,
    modifiedTime: driveItem.modifiedTime ?? new Date().toISOString(),
  };
}
async function dbRowOp(op: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await op();
  } catch (err) {
    captureError({ level: 'warn', source: MODULE, message: `${label}-db-failed: ${describeError(err)}` });
  }
}
