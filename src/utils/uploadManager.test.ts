// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import type { UploadSeed } from './uploadManager';
import type { DriveFileItem } from '../utils/driveApi';

// Mocks keep the manager isolated: driveApi/diskFs stand-ins for the network
// and Tauri IPC, errorLog/simpleToast/i18next for side effects we assert on.
vi.mock('../utils/driveApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/driveApi')>();
  return {
    ...actual, // keep the REAL UploadError class — `instanceof` must work
    uploadFileResumable: vi.fn(),
    getDriveStorageQuota: vi.fn(),
    createFolder: vi.fn(),
  };
});

vi.mock('../utils/diskFs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/diskFs')>();
  return {
    ...actual,
    readDiskFile: vi.fn(),
    walkDiskFolder: vi.fn(),
    registerUploadPath: vi.fn(),
  };
});

vi.mock('../utils/simpleToast', () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

vi.mock('../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

vi.mock('i18next', () => ({
  t: (key: string) => key,
}));

const TOKEN = 'test-token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_MIME = 'application/octet-stream';
const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

// Re-imported per test after vi.resetModules() so the manager's module-level
// queue/subscriber state starts clean (fresh vi.fn instances included).
let um: typeof import('./uploadManager');
let uploadFileResumable: ReturnType<typeof vi.fn>;
let getDriveStorageQuota: ReturnType<typeof vi.fn>;
let createFolderMock: ReturnType<typeof vi.fn>;
let readDiskFile: ReturnType<typeof vi.fn>;
let walkDiskFolder: ReturnType<typeof vi.fn>;
let registerUploadPath: ReturnType<typeof vi.fn>;
let showErrorToast: ReturnType<typeof vi.fn>;
let captureError: ReturnType<typeof vi.fn>;
let UploadErrorClass: typeof import('../utils/driveApi').UploadError;

beforeEach(async () => {
  vi.useRealTimers();
  // vi.mock factories are NOT re-run by vi.resetModules() (vitest caches the
  // mocked module), so the same vi.fn() instances persist — clear their call
  // history here; the default implementations are re-applied right below.
  vi.clearAllMocks();
  vi.resetModules();
  um = await import('./uploadManager');
  const da = await import('../utils/driveApi');
  const df = await import('../utils/diskFs');
  const st = await import('../utils/simpleToast');
  const el = await import('../utils/errorLog');
  uploadFileResumable = vi.mocked(da.uploadFileResumable);
  getDriveStorageQuota = vi.mocked(da.getDriveStorageQuota);
  createFolderMock = vi.mocked(da.createFolder);
  readDiskFile = vi.mocked(df.readDiskFile);
  walkDiskFolder = vi.mocked(df.walkDiskFolder);
  registerUploadPath = vi.mocked(df.registerUploadPath);
  showErrorToast = vi.mocked(st.showErrorToast);
  captureError = vi.mocked(el.captureError);
  UploadErrorClass = da.UploadError;

  // Default mocks: unlimited quota, tiny readable file, empty folder walk,
  // single folder creation, trivial upload success.
  getDriveStorageQuota.mockResolvedValue({ limit: null, usage: 0, usageInDrive: 0, usageInDriveTrash: 0 });
  readDiskFile.mockResolvedValue(new Uint8Array([9, 9]));
  walkDiskFolder.mockResolvedValue([]);
  registerUploadPath.mockResolvedValue(undefined);
  createFolderMock.mockResolvedValue({ id: 'folder-x', name: 'x', mimeType: FOLDER_MIME });
  uploadFileResumable.mockResolvedValue(makeDriveFile('file-x', 'x.mp3'));

  await db.files.clear();
  dispatchSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeDriveFile(id: string, name: string, mimeType: string = AUDIO_MIME): DriveFileItem {
  return { id, name, mimeType, size: '3', modifiedTime: '2026-01-01T00:00:00Z' };
}

function fileSeed(name: string, parentId: string = 'root', bytes: Uint8Array = new Uint8Array([1, 2, 3])): UploadSeed {
  return { name, isFolder: false, parentId, bytes };
}

function diskFileSeed(name: string, diskPath: string): UploadSeed {
  return { name, isFolder: false, parentId: 'root', diskPath };
}

function folderSeed(name: string, diskPath: string): UploadSeed {
  return { name, isFolder: true, parentId: 'root', diskPath };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// fake-indexeddb schedules every IDB operation via setImmediate (see
// fake-indexeddb lib/scheduling.js — jsdom does not provide it, so Node's real
// setImmediate is used). Under real timers a macrotask yield lets those ops
// land, which a pure-microtask flush would miss.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// Node's setImmediate is what fake-indexeddb schedules IDB work on (jsdom has
// none). It is not part of the DOM lib, so it is reached through a typed
// indirection; the fallback only matters on runtimes without it.
const nodeImmediate = (globalThis as unknown as Record<string, unknown>).setImmediate as
  | ((cb: () => void) => unknown)
  | undefined;

// Retry tests fake ONLY timers (never setImmediate) so db chains progress on
// the real event loop while the backoff stays controllable; this helper
// yields the event loop a few times.
async function realTick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    if (nodeImmediate) {
      await new Promise<void>((r) => nodeImmediate(() => r()));
    } else {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
}

// Fire only the faked timers (backoff sleep) — microtasks flush in between.
async function advanceBackoff(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const FAKE_TIMERS_TOFAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;

async function waitIdle(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (um.getUploadingIds().size > 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for upload queue to idle');
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  // The idle signal is keyed on entry.status, but markError flips status to
  // 'error' BEFORE its awaited pending-row delete + toast + notify finish
  // (markDone is symmetric: status flips AFTER the row writes). Without this
  // extra wait, assertions on those side effects (toast / captureError /
  // subscriber counts) race ahead of them and flake under CPU contention.
  await realTick(3);
}

function firedEvents(type: string): CustomEvent[] {
  return dispatchSpy.mock.calls
    .map((c) => c[0] as Event)
    .filter((e): e is CustomEvent => e.type === type && 'detail' in e);
}

describe('uploadManager', () => {
  it('1. queue tuần tự: upload tiếp theo chỉ bắt đầu sau khi cái trước xong', async () => {
    const d1 = deferred<DriveFileItem>();
    const d2 = deferred<DriveFileItem>();
    const d3 = deferred<DriveFileItem>();
    const pending = [d1.promise, d2.promise, d3.promise];
    let active = 0;
    let maxActive = 0;
    uploadFileResumable.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await pending.shift()!;
      } finally {
        active--;
      }
    });

    um.startUploads([fileSeed('a.mp3'), fileSeed('b.mp3'), fileSeed('c.mp3')], TOKEN);
    await flush();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(uploadFileResumable.mock.calls[0][2]).toBe('a.mp3');

    d1.resolve(makeDriveFile('f1', 'a.mp3'));
    await flush();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);
    expect(uploadFileResumable.mock.calls[1][2]).toBe('b.mp3');

    d2.resolve(makeDriveFile('f2', 'b.mp3'));
    await flush();
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
    d3.resolve(makeDriveFile('f3', 'c.mp3'));
    await waitIdle();

    expect(maxActive).toBe(1);
    expect(um.getEntries().map((e) => e.status)).toEqual(['done', 'done', 'done']);
  });

  it('2. happy path (bytes): pending row put khi uploading, row thật với drive id khi done', async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed('song.mp3')], TOKEN);
    await flush();

    let rows = await db.files.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^pending-/);
    expect(rows[0].name).toBe('song.mp3');
    expect(rows[0].mimeType).toBe(AUDIO_MIME);
    expect(rows[0].parentId).toBe('root');
    expect(rows[0].trashed).toBe(false);
    expect(rows[0].isFolder).toBe(false);
    expect(typeof rows[0].modifiedTime).toBe('string');

    expect(uploadFileResumable).toHaveBeenCalledWith(TOKEN, expect.any(Uint8Array), 'song.mp3', 'root');

    d.resolve(makeDriveFile('file-1', 'song.mp3'));
    await waitIdle();

    const entry = um.getEntries()[0];
    expect(entry.status).toBe('done');
    rows = await db.files.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('file-1');
    expect(rows[0].name).toBe('song.mp3');
    expect(rows[0].mimeType).toBe(AUDIO_MIME);
    expect(rows[0].parentId).toBe('root');
    expect(rows[0].size).toBe(3);
    expect(rows[0].trashed).toBe(false);
    expect(rows[0].isFolder).toBe(false);
  });

  it('3. UploadError invalid → entry error + pending row deleted + captureError + không retry', async () => {
    uploadFileResumable.mockRejectedValueOnce(new UploadErrorClass('bad request (400)', 'invalid'));

    um.startUploads([fileSeed('x.mp3')], TOKEN);
    await waitIdle();

    const entry = um.getEntries()[0];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('invalid');
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(await db.files.toArray()).toHaveLength(0);
    expect(captureError).toHaveBeenCalledWith(expect.objectContaining({ source: 'uploadManager' }));
  });

  it('4. quota exceeded → error quota + toast + không gọi upload', async () => {
    getDriveStorageQuota.mockResolvedValue({ limit: 100, usage: 90, usageInDrive: 90, usageInDriveTrash: 0 });

    um.startUploads([fileSeed('big.mp3', 'root', new Uint8Array(50))], TOKEN);
    await waitIdle();

    const entry = um.getEntries()[0];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('quota');
    expect(uploadFileResumable).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith('upload.quota_exceeded');
    expect(await db.files.toArray()).toHaveLength(0);
  });

  it('5. quota unlimited (limit=null) → upload vẫn chạy', async () => {
    um.startUploads([fileSeed('ok.mp3')], TOKEN);
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(um.getEntries()[0].status).toBe('done');
  });

  it('6. quota fetch fail (reject hoặc null) → không block, upload vẫn chạy', async () => {
    getDriveStorageQuota.mockRejectedValueOnce(new Error('network down'));
    getDriveStorageQuota.mockResolvedValueOnce(null);

    um.startUploads([fileSeed('a.mp3'), fileSeed('b.mp3')], TOKEN);
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(2);
    expect(um.getEntries().map((e) => e.status)).toEqual(['done', 'done']);
    expect(captureError).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  it('7. retry: network fail lần 1 → backoff 1s → lần 2 pass → done', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    uploadFileResumable
      .mockRejectedValueOnce(new UploadErrorClass('network hiccup', 'network'))
      .mockResolvedValueOnce(makeDriveFile('file-7', 'retry.mp3'));

    um.startUploads([fileSeed('retry.mp3')], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    await advanceBackoff(1000);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    await realTick();
    const entry = um.getEntries()[0];
    expect(entry.status).toBe('done');
    expect(entry.error).toBeUndefined();
  });

  it('8. retry hết: network x3 → error, đúng 3 calls', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    uploadFileResumable.mockRejectedValue(new UploadErrorClass('network down', 'network'));

    um.startUploads([fileSeed('n.mp3')], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    await advanceBackoff(1000);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    await advanceBackoff(3000);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
    await realTick();

    const entry = um.getEntries()[0];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('network');
    await advanceBackoff(10_000);
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
  });

  it('9. kind aborted → error ngay, 1 call duy nhất', async () => {
    uploadFileResumable.mockRejectedValueOnce(new UploadErrorClass('aborted', 'aborted'));

    um.startUploads([fileSeed('a.mp3')], TOKEN);
    await waitIdle();
    await new Promise((r) => setTimeout(r, 10));

    const entry = um.getEntries()[0];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('aborted');
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
  });

  it('10. folder upload: createFolder chuỗi + memoize subfolder + basename/parent đúng', async () => {
    walkDiskFolder.mockResolvedValue([
      { path: 'C:/Music/a.mp3', name: 'a.mp3', relativePath: 'a.mp3', isDirectory: false, size: 5 },
      { path: 'C:/Music/sub', name: 'sub', relativePath: 'sub', isDirectory: true, size: 0 },
      { path: 'C:/Music/sub/x.mp3', name: 'x.mp3', relativePath: 'sub/x.mp3', isDirectory: false, size: 5 },
      { path: 'C:/Music/sub/y.mp3', name: 'y.mp3', relativePath: 'sub/y.mp3', isDirectory: false, size: 5 },
    ]);
    let fileCounter = 0;
    createFolderMock.mockImplementation(async (_t, name) => ({
      id: name === 'Album' ? 'folder-1' : 'sub-1',
      name,
      mimeType: FOLDER_MIME,
    }));
    uploadFileResumable.mockImplementation(async (_t, _b, name) => makeDriveFile(`file-${++fileCounter}`, name));

    um.startUploads([folderSeed('Album', 'C:/Music')], TOKEN);
    await waitIdle();

    expect(registerUploadPath).toHaveBeenCalledTimes(1);
    expect(registerUploadPath).toHaveBeenCalledWith('C:/Music');
    expect(walkDiskFolder).toHaveBeenCalledWith('C:/Music');

    const folderCalls = createFolderMock.mock.calls;
    expect(folderCalls).toHaveLength(2);
    expect(folderCalls[0]).toEqual([TOKEN, 'Album', 'root']);
    expect(folderCalls[1]).toEqual([TOKEN, 'sub', 'folder-1']);

    const uploadNames = uploadFileResumable.mock.calls.map((c) => c[2]);
    const uploadParents = uploadFileResumable.mock.calls.map((c) => c[3]);
    expect(uploadNames).toEqual(['a.mp3', 'x.mp3', 'y.mp3']);
    expect(uploadParents).toEqual(['folder-1', 'sub-1', 'sub-1']);

    const readPaths = readDiskFile.mock.calls.map((c) => c[0]);
    expect(readPaths).toEqual(['C:/Music/a.mp3', 'C:/Music/sub/x.mp3', 'C:/Music/sub/y.mp3']);

    const rows = await db.files.toArray();
    expect(rows.map((r) => r.id).sort()).toEqual(['file-1', 'file-2', 'file-3', 'folder-1', 'sub-1']);
    expect(rows.filter((r) => r.isFolder).map((r) => r.id).sort()).toEqual(['folder-1', 'sub-1']);
    expect(rows.filter((r) => r.isFolder).every((r) => r.mimeType === FOLDER_MIME)).toBe(true);
  });

  it('11. folder pending row → row thật (id = driveId) sau createFolder', async () => {
    walkDiskFolder.mockResolvedValue([]);
    const d = deferred<DriveFileItem>();
    createFolderMock.mockReturnValueOnce(d.promise);

    um.startUploads([folderSeed('Album', 'C:/Music')], TOKEN);
    await flush();

    let rows = await db.files.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^pending-/);
    expect(rows[0].isFolder).toBe(true);
    expect(rows[0].mimeType).toBe(FOLDER_MIME);
    expect(rows[0].parentId).toBe('root');

    d.resolve({ id: 'folder-1', name: 'Album', mimeType: FOLDER_MIME });
    await waitIdle();

    rows = await db.files.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('folder-1');
    expect(rows[0].isFolder).toBe(true);
    expect(rows[0].mimeType).toBe(FOLDER_MIME);
    // quota check chỉ chạy trước file upload, không phải folder-create
    expect(getDriveStorageQuota).not.toHaveBeenCalled();
  });

  it('12. getUploadingIds: entry + parentId + driveId (folder), không bao giờ chứa root; sạch sau done', async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed('s.mp3', 'folder-9')], TOKEN);
    await flush();

    const entryId = um.getEntries()[0].id;
    const ids = um.getUploadingIds();
    expect(ids.has(entryId)).toBe(true);
    expect(ids.has('folder-9')).toBe(true);
    expect(ids.has('root')).toBe(false);
    expect(um.getUploadingIds()).not.toBe(ids);

    d.resolve(makeDriveFile('f9', 's.mp3'));
    await waitIdle();
    expect(um.getUploadingIds().size).toBe(0);
    expect(um.isUploading(entryId)).toBe(false);
  });

  it('12b. folder đang upload (đã có driveId) → driveId nằm trong uploading ids qua parentId của con', async () => {
    walkDiskFolder.mockResolvedValue([
      { path: 'C:/Music/a.mp3', name: 'a.mp3', relativePath: 'a.mp3', isDirectory: false, size: 5 },
    ]);
    createFolderMock.mockResolvedValue({ id: 'folder-1', name: 'Album', mimeType: FOLDER_MIME });
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([folderSeed('Album', 'C:/Music')], TOKEN);
    await flush();

    const ids = um.getUploadingIds();
    expect(ids.has('folder-1')).toBe(true);

    d.resolve(makeDriveFile('f1', 'a.mp3'));
    await waitIdle();
    expect(um.getUploadingIds().size).toBe(0);
  });

  it('13. subscribe/unsubscribe: cb gọi đúng số lần; unsubscribe → không gọi nữa', async () => {
    const cb = vi.fn();
    const unsub = um.subscribe(cb);

    um.startUploads([fileSeed('s.mp3')], TOKEN);
    await waitIdle();

    // queued-push + uploading + done = 3 lần
    expect(cb).toHaveBeenCalledTimes(3);
    expect(firedEvents('upload-status-changed')).toHaveLength(3);

    unsub();
    um.startUploads([fileSeed('t.mp3')], TOKEN);
    await waitIdle();
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('14. drive-files-changed fire sau mỗi done với detail.count=1', async () => {
    um.startUploads([fileSeed('s.mp3')], TOKEN);
    await waitIdle();

    const fired = firedEvents('drive-files-changed');
    expect(fired).toHaveLength(1);
    expect(fired[0].detail).toEqual({ count: 1 });
  });

  it('15. seed không hợp lệ → error invalid-seed ngay, không gọi API', async () => {
    um.startUploads([
      { name: 'FolderNoPath', isFolder: true, parentId: 'root' },
      { name: 'NoSource', isFolder: false, parentId: 'root' },
    ], TOKEN);
    await flush();

    const entries = um.getEntries();
    expect(entries.map((e) => e.status)).toEqual(['error', 'error']);
    expect(entries.map((e) => e.error)).toEqual(['invalid-seed', 'invalid-seed']);
    expect(uploadFileResumable).not.toHaveBeenCalled();
    expect(createFolderMock).not.toHaveBeenCalled();
  });

  it('16. startUploads khi queue đang chạy → nối thêm, không đụng entry đang upload', async () => {
    const d1 = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d1.promise).mockResolvedValueOnce(makeDriveFile('f2', 'b.mp3'));

    um.startUploads([fileSeed('a.mp3')], TOKEN);
    await flush();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    um.startUploads([fileSeed('b.mp3')], TOKEN);
    expect(um.getEntries()[1].status).toBe('queued');

    d1.resolve(makeDriveFile('f1', 'a.mp3'));
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(2);
    expect(um.getEntries().map((e) => e.status)).toEqual(['done', 'done']);
  });

  it('17. isUploading(id) theo đúng getUploadingIds', async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed('x.mp3')], TOKEN);
    await flush();

    const id = um.getEntries()[0].id;
    expect(um.isUploading(id)).toBe(true);
    expect(um.isUploading('root')).toBe(false);
    expect(um.isUploading('unknown-id')).toBe(false);

    d.resolve(makeDriveFile('f-x', 'x.mp3'));
    await waitIdle();
    expect(um.isUploading(id)).toBe(false);
  });

  it('file seed từ diskPath: register + readDiskFile + upload với basename', async () => {
    const path = 'C:\\Music\\Live Album\\Track One.mp3';
    um.startUploads([diskFileSeed('irrelevant', path)], TOKEN);
    await waitIdle();

    expect(registerUploadPath).toHaveBeenCalledWith(path);
    expect(readDiskFile).toHaveBeenCalledWith(path);
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    const call = uploadFileResumable.mock.calls[0];
    expect(call[2]).toBe('Track One.mp3');
    expect(call[3]).toBe('root');
    expect(call[1]).toBeInstanceOf(Uint8Array);
  });

  it('readDiskFile fail → entry error failed, không upload', async () => {
    readDiskFile.mockRejectedValue(new Error('os error 2'));
    um.startUploads([diskFileSeed('x', 'C:/x.mp3')], TOKEN);
    await waitIdle();

    const entry = um.getEntries()[0];
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('failed');
    expect(uploadFileResumable).not.toHaveBeenCalled();
    expect(await db.files.toArray()).toHaveLength(0);
  });

  it('getUploadState: entry.id đang upload/queued → uploading', async () => {
    const d = deferred<DriveFileItem>();
    // NOTE: no second once-implementation — the queue is sequential, so b.mp3
    // never starts while a.mp3 is deferred; a leftover once-impl would leak
    // into the next test (vitest clearAllMocks does NOT clear once-queue).
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed('a.mp3'), fileSeed('b.mp3')], TOKEN);
    await flush();

    const [a, b] = um.getEntries();
    expect(um.getUploadState(a.id)).toBe('uploading');
    expect(um.getUploadState(b.id)).toBe('uploading');
    expect(um.getUploadState('unknown-id')).toBe('none');

    d.resolve(makeDriveFile('f1', 'a.mp3'));
    await waitIdle();
  });

  it('getUploadState: folder batch — con đang upload (parentId=folder driveId) → folder chỉ parent-uploading (hết mờ)', async () => {
    walkDiskFolder.mockResolvedValue([
      { path: 'C:/Music/a.mp3', name: 'a.mp3', relativePath: 'a.mp3', isDirectory: false, size: 5 },
    ]);
    createFolderMock.mockResolvedValue({ id: 'folder-1', name: 'Album', mimeType: FOLDER_MIME });
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([folderSeed('Album', 'C:/Music')], TOKEN);
    await flush();

    // folder root đã done (driveId='folder-1'); con đang upload với parentId='folder-1'
    // → folder chỉ 'parent-uploading' (hết mờ, giữ spinner) — ADR deviation đã chốt.
    expect(um.getUploadState('folder-1')).toBe('parent-uploading');

    d.resolve(makeDriveFile('f-a', 'a.mp3'));
    await waitIdle();
  });

  it('getUploadState: parentId → parent-uploading; root không bao giờ parent-uploading', async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed('s.mp3', 'folder-9')], TOKEN);
    await flush();

    expect(um.getUploadState('folder-9')).toBe('parent-uploading');
    expect(um.getUploadState('root')).toBe('none');

    d.resolve(makeDriveFile('f9', 's.mp3'));
    await waitIdle();
  });

  it('getUploadState: sau done → none', async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed('s.mp3')], TOKEN);
    await flush();
    const id = um.getEntries()[0].id;
    expect(um.getUploadState(id)).toBe('uploading');

    d.resolve(makeDriveFile('f9', 's.mp3'));
    await waitIdle();
    expect(um.getUploadState(id)).toBe('none');
  });

  it('createFolder subfolder fail → subfolder error; file con trong đó → parent-folder-missing', async () => {
    walkDiskFolder.mockResolvedValue([
      { path: 'C:/Music/sub', name: 'sub', relativePath: 'sub', isDirectory: true, size: 0 },
      { path: 'C:/Music/sub/x.mp3', name: 'x.mp3', relativePath: 'sub/x.mp3', isDirectory: false, size: 5 },
    ]);
    createFolderMock.mockImplementation(async (_t, name) => {
      if (name === 'Album') return { id: 'folder-1', name, mimeType: FOLDER_MIME };
      throw new Error('create failed (400)');
    });

    um.startUploads([folderSeed('Album', 'C:/Music')], TOKEN);
    await waitIdle();

    const byError = Object.fromEntries(
      um.getEntries().map((e) => [e.name, e.status === 'error' ? e.error : e.status])
    );
    expect(byError['Album']).toBe('done');
    expect(byError['sub']).toBe('failed');
    expect(byError['x.mp3']).toBe('parent-folder-missing');
    expect(uploadFileResumable).not.toHaveBeenCalled();
  });
});
