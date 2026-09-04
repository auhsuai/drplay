// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { db } from "../db/db";
import type { UploadSessionRow } from "../db/db";
import type { UploadSeed } from "./uploadManager";
import type { DriveFileItem } from "../utils/driveApi";
import type {
  createFolder as createFolderImpl,
  getDriveStorageQuota as getDriveStorageQuotaImpl,
} from "../utils/driveApi";
import type {
  uploadFileResumable as uploadFileResumableImpl,
  uploadFileResumableChunked as uploadFileResumableChunkedImpl,
  generateClientId as generateClientIdImpl,
} from "../utils/driveUpload";
import type { DiskEntry } from "./diskFs";
import type {
  openDiskReadStream as openDiskReadStreamImpl,
  statDiskPath as statDiskPathImpl,
  walkDiskFolder as walkDiskFolderImpl,
  registerUploadPath as registerUploadPathImpl,
} from "./diskFs";
import type { showErrorToast as showErrorToastImpl } from "./simpleToast";
import type { captureError as captureErrorImpl } from "./errorLog";
import { USER_EMAIL_KEY } from "./storageKeys";
import { UPLOAD_SESSION_TTL_MS } from "./upload/session";
import enTranslations from "../locales/en/translation.json";
import viTranslations from "../locales/vi/translation.json";

// Mocks keep the manager isolated: driveApi/diskFs stand-ins for the network
// and Tauri IPC, errorLog/simpleToast/i18next for side effects we assert on.
vi.mock("../utils/driveApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/driveApi")>();
  return {
    ...actual,
    getDriveStorageQuota: vi.fn(),
    createFolder: vi.fn(),
  };
});

vi.mock("../utils/driveUpload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/driveUpload")>();
  return {
    ...actual, // keep the REAL UploadError class — `instanceof` must work
    generateClientId: vi.fn(),
    uploadFileResumable: vi.fn(),
    uploadFileResumableChunked: vi.fn(),
  };
});

vi.mock("../utils/diskFs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/diskFs")>();
  return {
    ...actual,
    openDiskReadStream: vi.fn(),
    statDiskPath: vi.fn(),
    walkDiskFolder: vi.fn(),
    registerUploadPath: vi.fn(),
  };
});

vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

vi.mock("../utils/errorLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/errorLog")>()),
  captureError: vi.fn(),
}));

vi.mock("i18next", () => ({
  t: (key: string) => key,
}));

const TOKEN = "test-token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const AUDIO_MIME = "application/octet-stream";
const dispatchSpy = vi.spyOn(window, "dispatchEvent");

// Re-imported per test after vi.resetModules() so the manager's module-level
// queue/subscriber state starts clean (fresh vi.fn instances included).
let um: typeof import("./uploadManager");
let uploadFileResumable: Mock<typeof uploadFileResumableImpl>;
let uploadFileResumableChunked: Mock<typeof uploadFileResumableChunkedImpl>;
let generateClientId: Mock<typeof generateClientIdImpl>;
let getDriveStorageQuota: Mock<typeof getDriveStorageQuotaImpl>;
let createFolderMock: Mock<typeof createFolderImpl>;
let openDiskReadStream: Mock<typeof openDiskReadStreamImpl>;
let statDiskPath: Mock<typeof statDiskPathImpl>;
let walkDiskFolder: Mock<typeof walkDiskFolderImpl>;
let registerUploadPath: Mock<typeof registerUploadPathImpl>;
let showErrorToast: Mock<typeof showErrorToastImpl>;
let captureError: Mock<typeof captureErrorImpl>;
let UploadErrorClass: typeof import("../utils/driveUpload").UploadError;

beforeEach(async () => {
  vi.useRealTimers();
  // vi.mock factories are NOT re-run by vi.resetModules() (vitest caches the
  // mocked module), so the same vi.fn() instances persist — clear their call
  // history here; the default implementations are re-applied right below.
  vi.clearAllMocks();
  vi.resetModules();
  um = await import("./uploadManager");
  const da = await import("../utils/driveApi");
  const du = await import("../utils/driveUpload");
  const df = await import("../utils/diskFs");
  const st = await import("../utils/simpleToast");
  const el = await import("../utils/errorLog");
  uploadFileResumable = vi.mocked(du.uploadFileResumable);
  uploadFileResumableChunked = vi.mocked(du.uploadFileResumableChunked);
  generateClientId = vi.mocked(du.generateClientId);
  getDriveStorageQuota = vi.mocked(da.getDriveStorageQuota);
  createFolderMock = vi.mocked(da.createFolder);
  openDiskReadStream = vi.mocked(df.openDiskReadStream);
  statDiskPath = vi.mocked(df.statDiskPath);
  walkDiskFolder = vi.mocked(df.walkDiskFolder);
  registerUploadPath = vi.mocked(df.registerUploadPath);
  showErrorToast = vi.mocked(st.showErrorToast);
  captureError = vi.mocked(el.captureError);
  UploadErrorClass = du.UploadError;

  // Default mocks: unlimited quota, tiny readable file, empty folder walk,
  // single folder creation, trivial upload success.
  getDriveStorageQuota.mockResolvedValue({
    limit: null,
    usage: 0,
    usageInDrive: 0,
    usageInDriveTrash: 0,
  });
  statDiskPath.mockResolvedValue({
    path: "x",
    name: "x",
    relativePath: "x",
    isDirectory: false,
    size: 2,
  });
  openDiskReadStream.mockResolvedValue({
    read: vi
      .fn()
      .mockResolvedValueOnce(new Uint8Array([9, 9]))
      .mockResolvedValueOnce(null),
    close: vi.fn().mockResolvedValue(undefined),
  });
  walkDiskFolder.mockResolvedValue([]);
  registerUploadPath.mockResolvedValue(undefined);
  createFolderMock.mockResolvedValue({
    id: "folder-x",
    name: "x",
    mimeType: FOLDER_MIME,
  });
  uploadFileResumable.mockResolvedValue(makeDriveFile("file-x", "x.mp3"));
  uploadFileResumableChunked.mockResolvedValue(
    makeDriveFile("file-x", "x.mp3"),
  );
  // Default: id generation unavailable (bare vi.fn() resolves undefined) →
  // the manager degrades to the legacy non-idempotent upload, so existing
  // tests keep exercising that fallback path.

  await db.files.clear();
  await db.uploadSessions.clear();
  dispatchSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeDriveFile(
  id: string,
  name: string,
  mimeType: string = AUDIO_MIME,
): DriveFileItem {
  return {
    id,
    name,
    mimeType,
    size: "3",
    modifiedTime: "2026-01-01T00:00:00Z",
  };
}

function fileSeed(
  name: string,
  parentId: string = "root",
  bytes: Uint8Array = new Uint8Array([1, 2, 3]),
): UploadSeed {
  return { name, isFolder: false, parentId, bytes };
}

function diskFileSeed(name: string, diskPath: string): UploadSeed {
  return { name, isFolder: false, parentId: "root", diskPath };
}

function folderSeed(name: string, diskPath: string): UploadSeed {
  return { name, isFolder: true, parentId: "root", diskPath };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// fake-indexeddb schedules every IDB operation via setImmediate (see
// fake-indexeddb lib/scheduling.js — jsdom does not provide it, so Node's real
// setImmediate is used). Under real timers a macrotask yield lets those ops
// land, which a pure-microtask flush would miss. 20 iterations covers the
// schema-v9 uploadSessions writes (persist + clear) on top of the files rows.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// Node's setImmediate is what fake-indexeddb schedules IDB work on (jsdom has
// none). It is not part of the DOM lib, so it is reached through a typed
// indirection; the fallback only matters on runtimes without it.
const nodeImmediate = (globalThis as unknown as Record<string, unknown>)
  .setImmediate as ((cb: () => void) => unknown) | undefined;

// Retry tests fake ONLY timers (never setImmediate) so db chains progress on
// the real event loop while the backoff stays controllable; this helper
// yields the event loop a few times. 10 yields covers the uploadSessions
// roundtrips (slice 5.1) between the pending-row write and the upload call.
async function realTick(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    if (nodeImmediate) {
      await new Promise<void>((r) => {
        nodeImmediate(() => {
          r();
        });
      });
    } else {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
}

// Fire only the faked timers (backoff sleep) — microtasks flush in between.
async function advanceBackoff(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const FAKE_TIMERS_TOFAKE = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
] as const;

async function waitIdle(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (um.getUploadingIds().size > 0) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for upload queue to idle");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  // The idle signal is keyed on entry.status, but markError flips status to
  // 'error' BEFORE its awaited pending-row delete + toast + notify finish
  // (markDone is symmetric: status flips AFTER the row writes). Without this
  // extra wait, assertions on those side effects (toast / captureError /
  // subscriber counts) race ahead of them and flake under CPU contention.
  // 10 yields also covers the slice-5.1 session clear (uploadSessions.delete)
  // that now sits between the status flip and finishEntry.
  await realTick(10);
}

function firedEvents(type: string): CustomEvent[] {
  return dispatchSpy.mock.calls
    .map((c) => c[0])
    .filter((e): e is CustomEvent => e.type === type && "detail" in e);
}

// Terminal entries are pruned right after the final notify(), so getEntries()
// no longer exposes them once the queue idles. The subscriber callback runs
// INSIDE notify() — before the prune — so snapshotting there still observes
// the terminal state while getEntries() after idle returns [].
function captureSnapshots(): Array<
  Array<{ status: string; error?: string | undefined }>
> {
  const snapshots: Array<
    Array<{ status: string; error?: string | undefined }>
  > = [];
  um.subscribe(() => {
    snapshots.push(
      um.getEntries().map((e) => ({ status: e.status, error: e.error })),
    );
  });
  return snapshots;
}

describe("uploadManager", () => {
  it("1. queue concurrency 2: 2 file đầu bắt đầu đồng thời theo FIFO, file 3 chỉ sau khi 1 trong 2 đầu xong", async () => {
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
        const next = pending.shift();
        if (next === undefined) throw new Error("upload queue exhausted");
        return await next;
      } finally {
        active--;
      }
    });

    const snapshots = captureSnapshots();

    um.startUploads(
      [fileSeed("a.mp3"), fileSeed("b.mp3"), fileSeed("c.mp3")],
      TOKEN,
    );
    await flush();
    // Concurrency 2: a và b cùng bắt đầu, FIFO theo thứ tự enqueue.
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);
    expect(uploadFileResumable.mock.calls[0]?.[2]).toBe("a.mp3");
    expect(uploadFileResumable.mock.calls[1]?.[2]).toBe("b.mp3");
    expect(maxActive).toBe(2);

    d1.resolve(makeDriveFile("f1", "a.mp3"));
    await flush();
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
    // c lấy đúng slot a vừa nhả (b vẫn đang upload).
    expect(uploadFileResumable.mock.calls[2]?.[2]).toBe("c.mp3");
    expect(maxActive).toBe(2); // chưa bao giờ vượt 2

    d2.resolve(makeDriveFile("f2", "b.mp3"));
    d3.resolve(makeDriveFile("f3", "c.mp3"));
    await waitIdle();

    expect(maxActive).toBe(2);
    // Subscriber snapshot of the last notify still carries the final 'done'.
    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
    expect(um.getEntries()).toEqual([]);
  });

  it("2. happy path (bytes): pending row put khi uploading, row thật với drive id khi done", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("song.mp3")], TOKEN);
    await flush();

    let rows = await db.files.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toMatch(/^pending-/);
    expect(rows[0]?.name).toBe("song.mp3");
    expect(rows[0]?.mimeType).toBe(AUDIO_MIME);
    expect(rows[0]?.parentId).toBe("root");
    expect(rows[0]?.trashed).toBe(false);
    expect(rows[0]?.isFolder).toBe(false);
    expect(typeof rows[0]?.modifiedTime).toBe("string");

    // The entry AbortController's signal must be wired into the upload call.
    expect(uploadFileResumable).toHaveBeenCalledWith(
      TOKEN,
      expect.any(Uint8Array),
      "song.mp3",
      "root",
      expect.any(AbortSignal),
      { clientGeneratedId: undefined },
    );

    d.resolve(makeDriveFile("file-1", "song.mp3"));
    await waitIdle();

    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
    expect(um.getEntries()).toEqual([]);
    rows = await db.files.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("file-1");
    expect(rows[0]?.name).toBe("song.mp3");
    expect(rows[0]?.mimeType).toBe(AUDIO_MIME);
    expect(rows[0]?.parentId).toBe("root");
    expect(rows[0]?.size).toBe(3);
    expect(rows[0]?.trashed).toBe(false);
    expect(rows[0]?.isFolder).toBe(false);
  });

  describe("enqueue-time pending rows (bugfix: multi-file visibility)", () => {
    it("R1. nhiều file upload → TẤT CẢ pending rows xuất hiện ngay tại enqueue (không phải chỉ file đang upload)", async () => {
      const da = deferred<DriveFileItem>();
      const dbB = deferred<DriveFileItem>();
      const dc = deferred<DriveFileItem>();
      // Cả 3 deferred: nếu b/c resolve ngay, row thật (f-b/f-c) thay thế
      // pending row của chúng trong lúc assert (concurrency 2).
      uploadFileResumable
        .mockReturnValueOnce(da.promise)
        .mockReturnValueOnce(dbB.promise)
        .mockReturnValueOnce(dc.promise);

      um.startUploads(
        [fileSeed("a.mp3"), fileSeed("b.mp3"), fileSeed("c.mp3")],
        TOKEN,
      );
      await flush();

      const rows = await db.files.toArray();
      // TRƯỚC fix: 1 row (chỉ a) → FAIL "expected 1 to be 3" hoặc tương tự
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.id.startsWith("pending-"))).toBe(true);
      expect(rows.map((r) => r.name).sort()).toEqual([
        "a.mp3",
        "b.mp3",
        "c.mp3",
      ]);
      expect(
        rows.every((r) => r.parentId === "root" && !r.trashed && !r.isFolder),
      ).toBe(true);

      da.resolve(makeDriveFile("f-a", "a.mp3"));
      dbB.resolve(makeDriveFile("f-b", "b.mp3"));
      dc.resolve(makeDriveFile("f-c", "c.mp3"));
      await waitIdle();
      const done = await db.files.toArray();
      expect(done).toHaveLength(3);
      expect(done.every((r) => !r.id.startsWith("pending-"))).toBe(true);
    });

    it("R2. cancel entry QUEUED → pending row của nó bị xóa ngay, các entry khác vẫn giữ rows", async () => {
      const da = deferred<DriveFileItem>();
      const dbB = deferred<DriveFileItem>();
      uploadFileResumable
        .mockReturnValueOnce(da.promise)
        .mockReturnValueOnce(dbB.promise)
        .mockImplementation((_t, _bytes, name) =>
          Promise.resolve(makeDriveFile(`f-${name}`, name)),
        );

      um.startUploads(
        [fileSeed("a.mp3"), fileSeed("b.mp3"), fileSeed("c.mp3")],
        TOKEN,
      );
      await flush();

      // Cả 3 đều có pending rows ngay tại enqueue (c chưa từng được pump xử lý).
      expect(await db.files.toArray()).toHaveLength(3);
      // Concurrency 2: a, b đang upload → c nằm queued chờ slot.
      const c = um.getEntries().find((e) => e.name === "c.mp3");
      if (!c) throw new Error("expected queued entry c.mp3");
      expect(c.status).toBe("queued");

      um.cancelUpload(c.id);
      await flush();

      const after = await db.files.toArray();
      expect(after).toHaveLength(2);
      expect(after.map((r) => r.name).sort()).toEqual(["a.mp3", "b.mp3"]);
      expect(after.every((r) => r.id.startsWith("pending-"))).toBe(true);
      expect(uploadFileResumable).toHaveBeenCalledTimes(2); // c chưa bao giờ start

      da.resolve(makeDriveFile("f-a", "a.mp3"));
      dbB.resolve(makeDriveFile("f-b", "b.mp3"));
      await waitIdle();
      const done = await db.files.toArray();
      expect(done).toHaveLength(2);
      expect(done.every((r) => !r.id.startsWith("pending-"))).toBe(true);
    });

    it("R3. seed invalid (folder không diskPath) trộn với seed hợp lệ → invalid KHÔNG tạo pending row, hợp lệ vẫn có", async () => {
      const da = deferred<DriveFileItem>();
      const dbB = deferred<DriveFileItem>();
      // Concurrency 2: cả 2 hợp lệ start ngay — nếu b resolve ngay, row thật
      // (f-b) thay thế pending row của nó trong lúc assert.
      uploadFileResumable
        .mockReturnValueOnce(da.promise)
        .mockReturnValueOnce(dbB.promise);

      um.startUploads(
        [
          { name: "FolderNoPath", isFolder: true, parentId: "root" }, // invalid
          fileSeed("a.mp3"),
          fileSeed("b.mp3"),
        ],
        TOKEN,
      );
      await flush();

      const rows = await db.files.toArray();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.id.startsWith("pending-"))).toBe(true);
      expect(rows.map((r) => r.name).sort()).toEqual(["a.mp3", "b.mp3"]);

      da.resolve(makeDriveFile("f-a", "a.mp3"));
      dbB.resolve(makeDriveFile("f-b", "b.mp3"));
      await waitIdle();
    });

    it("R4. folder root: đúng 1 pending row tại enqueue — KHÔNG có row thừa nào", async () => {
      walkDiskFolder.mockResolvedValue([]);
      const d = deferred<DriveFileItem>();
      createFolderMock.mockReturnValueOnce(d.promise);

      um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
      await flush();

      const rows = await db.files.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toMatch(/^pending-/);
      expect(rows[0]?.name).toBe("Album");
      expect(rows[0]?.isFolder).toBe(true);
      expect(rows[0]?.mimeType).toBe(FOLDER_MIME);
      expect(rows[0]?.parentId).toBe("root");

      d.resolve({ id: "folder-1", name: "Album", mimeType: FOLDER_MIME });
      await waitIdle();
      const done = await db.files.toArray();
      expect(done.map((r) => r.id)).toEqual(["folder-1"]);
    });

    it("R4b. folder child: chưa có pending row cho con với parentId placeholder — con nhận row khi processEntry chạy", async () => {
      walkDiskFolder.mockResolvedValue([
        {
          path: "C:/Music/a.mp3",
          name: "a.mp3",
          relativePath: "a.mp3",
          isDirectory: false,
          size: 5,
        },
      ]);
      const dRoot = deferred<DriveFileItem>();
      createFolderMock.mockReturnValueOnce(dRoot.promise);
      const dFile = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(dFile.promise);

      um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
      await flush();

      // Root chưa resolve → rows CHỈ có folder root; con đã được enqueue bởi
      // handleFolderRoot nhưng phải KHÔNG có row (parentId của nó là placeholder).
      let rows = await db.files.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("Album");
      expect(rows[0]?.id).toMatch(/^pending-/);

      dRoot.resolve({ id: "folder-1", name: "Album", mimeType: FOLDER_MIME });
      await flush();

      // Con bắt đầu được xử lý → row của con xuất hiện qua processEntry (như cũ).
      rows = await db.files.toArray();
      expect(rows).toHaveLength(2);
      const child = rows.find((r) => r.name === "a.mp3");
      expect(child?.id).toMatch(/^pending-/);

      dFile.resolve(makeDriveFile("f-a", "a.mp3"));
      await waitIdle();
      const done = await db.files.toArray();
      // 'f-a' sorts before 'folder-1' lexically ('-' < 'o') — order from sort().
      expect(done.map((r) => r.id).sort()).toEqual(["f-a", "folder-1"]);
      expect(done.find((r) => r.name === "a.mp3")?.parentId).toBe("folder-1");
    });
  });

  it("3. UploadError invalid → entry error + pending row deleted + captureError + không retry", async () => {
    uploadFileResumable.mockRejectedValueOnce(
      new UploadErrorClass("bad request (400)", "invalid"),
    );
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("x.mp3")], TOKEN);
    await waitIdle();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "invalid" },
    ]);
    expect(um.getEntries()).toEqual([]);
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(await db.files.toArray()).toHaveLength(0);
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "uploadManager" }),
    );
  });

  it("4. quota exceeded → error quota + toast + không gọi upload", async () => {
    getDriveStorageQuota.mockResolvedValue({
      limit: 100,
      usage: 90,
      usageInDrive: 90,
      usageInDriveTrash: 0,
    });
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("big.mp3", "root", new Uint8Array(50))], TOKEN);
    await waitIdle();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "quota" },
    ]);
    expect(um.getEntries()).toEqual([]);
    expect(uploadFileResumable).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith("upload.quota_exceeded");
    expect(await db.files.toArray()).toHaveLength(0);
  });

  it("5. quota unlimited (limit=null) → upload vẫn chạy", async () => {
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("ok.mp3")], TOKEN);
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
  });

  it("6. quota fetch fail (reject hoặc null) → không block, upload vẫn chạy", async () => {
    getDriveStorageQuota.mockRejectedValueOnce(new Error("network down"));
    getDriveStorageQuota.mockResolvedValueOnce(null);
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("a.mp3"), fileSeed("b.mp3")], TOKEN);
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(2);
    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
    expect(um.getEntries()).toEqual([]);
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn" }),
    );
  });

  it("7. retry: network fail lần 1 → backoff 1–1.5s (exp+jitter) → lần 2 pass → done", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    uploadFileResumable
      .mockRejectedValueOnce(new UploadErrorClass("network hiccup", "network"))
      .mockResolvedValueOnce(makeDriveFile("file-7", "retry.mp3"));
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("retry.mp3")], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    await advanceBackoff(1500); // backoffDelay(attempt-1=0) ∈ [1000, 1500)
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    await realTick();
    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "done", error: undefined },
    ]);
    expect(um.getEntries()).toEqual([]);
  });

  it("8. retry hết: network x3 → error, đúng 3 calls", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    uploadFileResumable.mockRejectedValue(
      new UploadErrorClass("network down", "network"),
    );
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("n.mp3")], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    await advanceBackoff(1500); // backoffDelay(attempt-1=0) ∈ [1000, 1500)
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    await advanceBackoff(3000); // backoffDelay(attempt-1=1) ∈ [2000, 3000)
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
    await realTick();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "network" },
    ]);
    expect(um.getEntries()).toEqual([]);
    await advanceBackoff(10_000);
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
  });

  it("9. kind aborted → error ngay, 1 call duy nhất", async () => {
    uploadFileResumable.mockRejectedValueOnce(
      new UploadErrorClass("aborted", "aborted"),
    );
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("a.mp3")], TOKEN);
    await waitIdle();
    await new Promise((r) => setTimeout(r, 10));

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "aborted" },
    ]);
    expect(um.getEntries()).toEqual([]);
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
  });

  it("9b. retry idempotent: moi attempt dung CUNG pre-generated id (fix file trung)", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    generateClientId.mockResolvedValue("gen-42");
    uploadFileResumable
      .mockRejectedValueOnce(new UploadErrorClass("network hiccup", "network"))
      .mockResolvedValueOnce(makeDriveFile("file-42", "idem.mp3"));
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("idem.mp3")], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(generateClientId).toHaveBeenCalledTimes(1);

    await advanceBackoff(1500); // backoffDelay(attempt-1=0) ∈ [1000, 1500)
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    // Both attempts MUST bind the SAME id — a fresh id per attempt would let a
    // retry after a response-lost success create a duplicate file on Drive.
    const ids = uploadFileResumable.mock.calls.map(
      (c) => c[5]?.clientGeneratedId,
    );
    expect(ids).toEqual(["gen-42", "gen-42"]);
    expect(generateClientId).toHaveBeenCalledTimes(1);
    await realTick();
    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "done", error: undefined },
    ]);
  });

  it("9c. generateClientId fail (network) -> fallback upload KHONG id, khong block, warn log", async () => {
    generateClientId.mockRejectedValue(new Error("network down"));
    uploadFileResumable.mockResolvedValue(makeDriveFile("file-fb", "fb.mp3"));
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("fb.mp3")], TOKEN);
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(uploadFileResumable.mock.calls[0]?.[5]).toEqual({
      clientGeneratedId: undefined,
    });
    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
    expect(um.getEntries()).toEqual([]);
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "client-id-generation-failed",
        ) as unknown as string,
      }),
    );
  });

  it("9e. retry: UploadError network kèm status 429 (transport map) → backoff HONOR Retry-After 5s → lần 2 pass", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    // The transport now surfaces transient HTTP (429) as kind 'network' with
    // the Retry-After header; the manager's single retry layer must sleep
    // ~5s (RFC 9110) instead of the 1–1.5s exponential base.
    uploadFileResumable
      .mockRejectedValueOnce(
        new UploadErrorClass("rate limited (429)", "network", 429, "5"),
      )
      .mockResolvedValueOnce(makeDriveFile("file-9e", "ra.mp3"));
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("ra.mp3")], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    // 4.9s in: the Retry-After sleep (5s) has NOT elapsed — exp+jitter would
    // have fired by now, so this bounds the sleep to the honored header.
    await advanceBackoff(4900);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    // Crossing 5s: the Retry-After sleep resolves → attempt 2 fires.
    await advanceBackoff(200);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    await realTick();
    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "done", error: undefined },
    ]);
    expect(um.getEntries()).toEqual([]);
  });

  it("9f. retry hết: network x3 kèm status 500 → đúng 3 calls, error cuối kind network", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    uploadFileResumable.mockRejectedValue(
      new UploadErrorClass("server error", "network", 500),
    );
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("n500.mp3")], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    await advanceBackoff(1500);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    await advanceBackoff(3000);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
    await realTick();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "network" },
    ]);
    expect(um.getEntries()).toEqual([]);
    await advanceBackoff(10_000);
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
  });

  it("9g. kind auth (status 401) → không retry, 1 call, error auth", async () => {
    uploadFileResumable.mockRejectedValueOnce(
      new UploadErrorClass("unauthorized (401)", "auth", 401),
    );
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("auth.mp3")], TOKEN);
    await waitIdle();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "auth" },
    ]);
    expect(um.getEntries()).toEqual([]);
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
  });

  it("9h. kind quota (status 403) → không retry, 1 call, error quota", async () => {
    uploadFileResumable.mockRejectedValueOnce(
      new UploadErrorClass("drive storage quota exceeded", "quota", 403),
    );
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("quota.mp3")], TOKEN);
    await waitIdle();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "quota" },
    ]);
    expect(um.getEntries()).toEqual([]);
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
  });

  it("9i. cancel giữa backoff → không attempt tiếp (abort thắng retry)", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    uploadFileResumable.mockRejectedValue(
      new UploadErrorClass("network hiccup", "network"),
    );
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("ab.mp3")], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    const entry = um.getEntries()[0];
    if (!entry) throw new Error("expected upload entry");
    um.cancelUpload(entry.id);

    // Even with the backoff fully elapsed, the aborted signal must stop the
    // loop from firing a second attempt.
    await advanceBackoff(10_000);
    await realTick();

    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "aborted" },
    ]);
    expect(um.getEntries()).toEqual([]);
  });

  it("9d. disk path: 1 pre-generated id per entry truyen vao chunked uploader", async () => {
    generateClientId.mockResolvedValue("gen-7");
    const snapshots = captureSnapshots();

    um.startUploads([diskFileSeed("d.flac", "C:/Music/d.flac")], TOKEN);
    await waitIdle();

    expect(generateClientId).toHaveBeenCalledTimes(1);
    expect(uploadFileResumableChunked).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ clientGeneratedId: "gen-7" }),
    );
    expect(uploadFileResumable).not.toHaveBeenCalled();
    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
  });

  it("10. folder upload: createFolder chuỗi + memoize subfolder + basename/parent đúng", async () => {
    walkDiskFolder.mockResolvedValue([
      {
        path: "C:/Music/a.mp3",
        name: "a.mp3",
        relativePath: "a.mp3",
        isDirectory: false,
        size: 5,
      },
      {
        path: "C:/Music/sub",
        name: "sub",
        relativePath: "sub",
        isDirectory: true,
        size: 0,
      },
      {
        path: "C:/Music/sub/x.mp3",
        name: "x.mp3",
        relativePath: "sub/x.mp3",
        isDirectory: false,
        size: 5,
      },
      {
        path: "C:/Music/sub/y.mp3",
        name: "y.mp3",
        relativePath: "sub/y.mp3",
        isDirectory: false,
        size: 5,
      },
    ]);
    let fileCounter = 0;
    createFolderMock.mockImplementation((_t, name) =>
      Promise.resolve({
        id: name === "Album" ? "folder-1" : "sub-1",
        name,
        mimeType: FOLDER_MIME,
      }),
    );
    uploadFileResumableChunked.mockImplementation((_t, opts) =>
      Promise.resolve(
        makeDriveFile(`file-${String(++fileCounter)}`, opts.name),
      ),
    );

    um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
    await waitIdle();

    expect(registerUploadPath).toHaveBeenCalledTimes(1);
    expect(registerUploadPath).toHaveBeenCalledWith("C:/Music");
    expect(walkDiskFolder).toHaveBeenCalledWith(
      "C:/Music",
      expect.any(AbortSignal),
    );

    const folderCalls = createFolderMock.mock.calls;
    expect(folderCalls).toHaveLength(2);
    expect(folderCalls[0]).toEqual([
      TOKEN,
      "Album",
      "root",
      expect.any(AbortSignal),
    ]);
    expect(folderCalls[1]).toEqual([
      TOKEN,
      "sub",
      "folder-1",
      expect.any(AbortSignal),
    ]);

    const uploadNames = uploadFileResumableChunked.mock.calls.map(
      (c) => c[1].name,
    );
    const uploadParents = uploadFileResumableChunked.mock.calls.map(
      (c) => c[1].parentId,
    );
    expect(uploadNames).toEqual(["a.mp3", "x.mp3", "y.mp3"]);
    expect(uploadParents).toEqual(["folder-1", "sub-1", "sub-1"]);

    const readPaths = openDiskReadStream.mock.calls.map((c) => c[0]);
    expect(readPaths).toEqual([
      "C:/Music/a.mp3",
      "C:/Music/sub/x.mp3",
      "C:/Music/sub/y.mp3",
    ]);
    // Bytes path must NOT be used for disk files (streaming replaces it).
    expect(uploadFileResumable).not.toHaveBeenCalled();

    const rows = await db.files.toArray();
    expect(rows.map((r) => r.id).sort()).toEqual([
      "file-1",
      "file-2",
      "file-3",
      "folder-1",
      "sub-1",
    ]);
    expect(
      rows
        .filter((r) => r.isFolder)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["folder-1", "sub-1"]);
    expect(
      rows.filter((r) => r.isFolder).every((r) => r.mimeType === FOLDER_MIME),
    ).toBe(true);
  });

  it("11. folder pending row → row thật (id = driveId) sau createFolder", async () => {
    walkDiskFolder.mockResolvedValue([]);
    const d = deferred<DriveFileItem>();
    createFolderMock.mockReturnValueOnce(d.promise);

    um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
    await flush();

    let rows = await db.files.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toMatch(/^pending-/);
    expect(rows[0]?.isFolder).toBe(true);
    expect(rows[0]?.mimeType).toBe(FOLDER_MIME);
    expect(rows[0]?.parentId).toBe("root");

    d.resolve({ id: "folder-1", name: "Album", mimeType: FOLDER_MIME });
    await waitIdle();

    rows = await db.files.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("folder-1");
    expect(rows[0]?.isFolder).toBe(true);
    expect(rows[0]?.mimeType).toBe(FOLDER_MIME);
    // quota check chỉ chạy trước file upload, không phải folder-create
    expect(getDriveStorageQuota).not.toHaveBeenCalled();
  });

  it("12. getUploadingIds: entry + parentId + driveId (folder), không bao giờ chứa root; sạch sau done", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3", "folder-9")], TOKEN);
    await flush();

    const firstEntry = um.getEntries()[0];
    if (!firstEntry) throw new Error("expected upload entry");
    const entryId = firstEntry.id;
    const ids = um.getUploadingIds();
    expect(ids.has(entryId)).toBe(true);
    expect(ids.has("folder-9")).toBe(true);
    expect(ids.has("root")).toBe(false);
    expect(um.getUploadingIds()).not.toBe(ids);

    d.resolve(makeDriveFile("f9", "s.mp3"));
    await waitIdle();
    expect(um.getUploadingIds().size).toBe(0);
    expect(um.isUploading(entryId)).toBe(false);
  });

  it("12b. folder đang upload (đã có driveId) → driveId nằm trong uploading ids qua parentId của con", async () => {
    walkDiskFolder.mockResolvedValue([
      {
        path: "C:/Music/a.mp3",
        name: "a.mp3",
        relativePath: "a.mp3",
        isDirectory: false,
        size: 5,
      },
    ]);
    createFolderMock.mockResolvedValue({
      id: "folder-1",
      name: "Album",
      mimeType: FOLDER_MIME,
    });
    const d = deferred<DriveFileItem>();
    uploadFileResumableChunked.mockReturnValueOnce(d.promise);

    um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
    await flush();

    const ids = um.getUploadingIds();
    expect(ids.has("folder-1")).toBe(true);

    d.resolve(makeDriveFile("f1", "a.mp3"));
    await waitIdle();
    expect(um.getUploadingIds().size).toBe(0);
  });

  it("13. subscribe/unsubscribe: cb gọi đúng số lần; unsubscribe → không gọi nữa", async () => {
    const cb = vi.fn();
    const unsub = um.subscribe(cb);

    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await waitIdle();

    // queued-push + uploading + done = 3 lần
    expect(cb).toHaveBeenCalledTimes(3);
    // Guard: the legacy 'upload-status-changed' window event was removed
    // (0 production listeners) — notify() must not re-dispatch it.
    expect(firedEvents("upload-status-changed")).toHaveLength(0);

    unsub();
    um.startUploads([fileSeed("t.mp3")], TOKEN);
    await waitIdle();
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("14. drive-files-changed fire sau mỗi done với detail.count=1", async () => {
    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await waitIdle();

    const fired = firedEvents("drive-files-changed");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.detail).toEqual({ count: 1 });
  });

  it("15. seed không hợp lệ → error invalid-seed ngay, không gọi API", async () => {
    um.startUploads(
      [
        { name: "FolderNoPath", isFolder: true, parentId: "root" },
        { name: "NoSource", isFolder: false, parentId: "root" },
      ],
      TOKEN,
    );
    await flush();

    const entries = um.getEntries();
    expect(entries.map((e) => e.status)).toEqual(["error", "error"]);
    expect(entries.map((e) => e.error)).toEqual([
      "invalid-seed",
      "invalid-seed",
    ]);
    expect(uploadFileResumable).not.toHaveBeenCalled();
    expect(createFolderMock).not.toHaveBeenCalled();
  });

  it("16. startUploads khi queue đang chạy → nối thêm, không đụng entry đang upload", async () => {
    const d1 = deferred<DriveFileItem>();
    uploadFileResumable
      .mockReturnValueOnce(d1.promise)
      .mockResolvedValueOnce(makeDriveFile("f2", "b.mp3"));
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("a.mp3")], TOKEN);
    await flush();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    um.startUploads([fileSeed("b.mp3")], TOKEN);
    expect(um.getEntries()[1]?.status).toBe("queued");

    d1.resolve(makeDriveFile("f1", "a.mp3"));
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(2);
    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
    expect(um.getEntries()).toEqual([]);
  });

  it("16b. queue lớn (50 entries): pump giữ FIFO đúng thứ tự, không bỏ sót entry dù prune giữa chừng", async () => {
    const names = Array.from(
      { length: 50 },
      (_, i) => `t${String(i).padStart(2, "0")}.mp3`,
    );
    const called: string[] = [];
    uploadFileResumable.mockImplementation((_t, _bytes, name) => {
      called.push(name);
      return Promise.resolve(makeDriveFile(`f-${String(called.length)}`, name));
    });

    um.startUploads(
      names.map((n) => fileSeed(n)),
      TOKEN,
    );
    await waitIdle();

    expect(called).toHaveLength(50);
    expect(called).toEqual(names); // FIFO: đúng thứ tự enqueue
    expect(um.getEntries()).toEqual([]);
  });

  it("17b. concurrency 2: 2 file bắt đầu chồng nhau — entry 2 start trước khi entry 1 xong", async () => {
    const d1 = deferred<DriveFileItem>();
    const d2 = deferred<DriveFileItem>();
    const pending = [d1.promise, d2.promise];
    const started: string[] = [];
    uploadFileResumable.mockImplementation(async (_t, _bytes, name) => {
      started.push(name);
      const next = pending.shift();
      if (next === undefined) throw new Error("upload queue exhausted");
      return await next;
    });

    um.startUploads([fileSeed("a.mp3"), fileSeed("b.mp3")], TOKEN);
    await flush();

    // Cả 2 đã start dù chưa cái nào xong (sequential cũ: chỉ a).
    expect(started).toEqual(["a.mp3", "b.mp3"]);
    expect(um.getEntries().map((e) => e.name)).toEqual(["a.mp3", "b.mp3"]);

    d1.resolve(makeDriveFile("f1", "a.mp3"));
    d2.resolve(makeDriveFile("f2", "b.mp3"));
    await waitIdle();
    expect(um.getEntries()).toEqual([]);
  });

  it("17c. concurrency 2: 3 file → tối đa 2 upload cùng lúc; entry 3 start sau khi 1 trong 2 entry đầu xong", async () => {
    const d1 = deferred<DriveFileItem>();
    const d2 = deferred<DriveFileItem>();
    const d3 = deferred<DriveFileItem>();
    const pending = [d1.promise, d2.promise, d3.promise];
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    uploadFileResumable.mockImplementation(async (_t, _bytes, name) => {
      started.push(name);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        const next = pending.shift();
        if (next === undefined) throw new Error("upload queue exhausted");
        return await next;
      } finally {
        active--;
      }
    });

    um.startUploads(
      [fileSeed("a.mp3"), fileSeed("b.mp3"), fileSeed("c.mp3")],
      TOKEN,
    );
    await flush();

    expect(started).toEqual(["a.mp3", "b.mp3"]); // 2 slots — c chưa start
    expect(maxActive).toBe(2);

    d1.resolve(makeDriveFile("f1", "a.mp3"));
    await flush();
    // c start ngay khi a xong (slot 1 vừa nhả), b vẫn đang upload.
    expect(started).toEqual(["a.mp3", "b.mp3", "c.mp3"]);
    expect(maxActive).toBe(2); // không bao giờ vượt 2

    d2.resolve(makeDriveFile("f2", "b.mp3"));
    d3.resolve(makeDriveFile("f3", "c.mp3"));
    await waitIdle();
    expect(um.getEntries()).toEqual([]);
  });

  it("17d. concurrency 2: folder child file KHÔNG start trước khi subfolder parent resolve memo ('' marker)", async () => {
    walkDiskFolder.mockResolvedValue([
      {
        path: "C:/Music/a.mp3",
        name: "a.mp3",
        relativePath: "a.mp3",
        isDirectory: false,
        size: 5,
      },
      {
        path: "C:/Music/sub",
        name: "sub",
        relativePath: "sub",
        isDirectory: true,
        size: 0,
      },
      {
        path: "C:/Music/sub/x.mp3",
        name: "x.mp3",
        relativePath: "sub/x.mp3",
        isDirectory: false,
        size: 5,
      },
    ]);
    const dSub = deferred<DriveFileItem>();
    createFolderMock.mockImplementation((_t, name) => {
      if (name === "Album")
        return Promise.resolve({ id: "folder-1", name, mimeType: FOLDER_MIME });
      return dSub.promise; // 'sub' deferred — memo của nó chưa resolve
    });
    const dA = deferred<DriveFileItem>();
    const dX = deferred<DriveFileItem>();
    uploadFileResumableChunked
      .mockReturnValueOnce(dA.promise)
      .mockReturnValueOnce(dX.promise);

    um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
    await flush();

    // a.mp3 (root-level) + sub đang upload song song (2 slots); x.mp3 queued
    // chờ sub resolve memo (sequential cũ: sub chưa bắt đầu → RED).
    expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
    expect(uploadFileResumableChunked.mock.calls[0]?.[1]?.name).toBe("a.mp3");
    expect(createFolderMock).toHaveBeenCalledTimes(2); // Album + sub

    // a xong → slot free → x VẪN không được claim (sub chưa resolve memo).
    dA.resolve(makeDriveFile("f-a", "a.mp3"));
    await flush();
    expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
    expect(um.getEntries().find((e) => e.name === "x.mp3")?.status).toBe(
      "queued",
    );

    // sub resolve → memo 'sub' -> sub-1 → x được claim.
    dSub.resolve({ id: "sub-1", name: "sub", mimeType: FOLDER_MIME });
    await flush();
    expect(uploadFileResumableChunked).toHaveBeenCalledTimes(2);
    expect(uploadFileResumableChunked.mock.calls[1]?.[1]?.name).toBe("x.mp3");
    expect(uploadFileResumableChunked.mock.calls[1]?.[1]?.parentId).toBe(
      "sub-1",
    );

    dX.resolve(makeDriveFile("f-x", "x.mp3"));
    await waitIdle();
    expect(um.getEntries()).toEqual([]);
  });

  it("17. isUploading(id) theo đúng getUploadingIds", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("x.mp3")], TOKEN);
    await flush();

    const firstEntry = um.getEntries()[0];
    if (!firstEntry) throw new Error("expected upload entry");
    const id = firstEntry.id;
    expect(um.isUploading(id)).toBe(true);
    expect(um.isUploading("root")).toBe(false);
    expect(um.isUploading("unknown-id")).toBe(false);

    d.resolve(makeDriveFile("f-x", "x.mp3"));
    await waitIdle();
    expect(um.isUploading(id)).toBe(false);
  });

  it("file seed từ diskPath: register + stat + openDiskReadStream + chunked upload với basename", async () => {
    const path = "C:\\Music\\Live Album\\Track One.mp3";
    um.startUploads([diskFileSeed("irrelevant", path)], TOKEN);
    await waitIdle();

    expect(registerUploadPath).toHaveBeenCalledWith(path);
    expect(statDiskPath).toHaveBeenCalledWith(path);
    expect(openDiskReadStream).toHaveBeenCalledWith(path);
    expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
    const firstCall = uploadFileResumableChunked.mock.calls[0];
    if (firstCall === undefined)
      throw new Error("expected chunked upload call");
    const opts = firstCall[1];
    expect(opts.name).toBe("Track One.mp3");
    expect(opts.parentId).toBe("root");
    expect(opts.totalSize).toBe(2);
    expect(typeof opts.readChunk).toBe("function");
    expect(typeof opts.onProgress).toBe("function");
    // Disk files stream via the chunked uploader — the whole-file bytes path
    // must NOT be used.
    expect(uploadFileResumable).not.toHaveBeenCalled();

    // The stream opened for the upload is closed on completion (finally).
    // (mock.results holds the raw Promise — await it to get the stream.)
    const firstResult = openDiskReadStream.mock.results[0];
    if (firstResult === undefined)
      throw new Error("expected stream open result");
    const stream = (await firstResult.value) as {
      close: ReturnType<typeof vi.fn>;
    };
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("openDiskReadStream fail → entry error failed, không upload", async () => {
    openDiskReadStream.mockRejectedValue(new Error("os error 2"));
    const snapshots = captureSnapshots();

    um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
    await waitIdle();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "failed" },
    ]);
    expect(um.getEntries()).toEqual([]);
    expect(uploadFileResumableChunked).not.toHaveBeenCalled();
    expect(await db.files.toArray()).toHaveLength(0);
  });

  it("statDiskPath null (file biến mất giữa chừng) → entry error failed, không upload", async () => {
    statDiskPath.mockResolvedValue(null);
    const snapshots = captureSnapshots();

    um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
    await waitIdle();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "failed" },
    ]);
    expect(openDiskReadStream).not.toHaveBeenCalled();
    expect(uploadFileResumableChunked).not.toHaveBeenCalled();
  });

  it("disk file: totalSize từ stat được dùng cho quota check trước khi mở stream", async () => {
    getDriveStorageQuota.mockResolvedValue({
      limit: 100,
      usage: 99,
      usageInDrive: 99,
      usageInDriveTrash: 0,
    });
    statDiskPath.mockResolvedValue({
      path: "C:/big.flac",
      name: "big.flac",
      relativePath: "big.flac",
      isDirectory: false,
      size: 2,
    });
    const snapshots = captureSnapshots();

    um.startUploads([diskFileSeed("x", "C:/big.flac")], TOKEN);
    await waitIdle();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "quota" },
    ]);
    expect(openDiskReadStream).not.toHaveBeenCalled();
    expect(uploadFileResumableChunked).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith("upload.quota_exceeded");
  });

  it("chunked upload progress: onProgress ghi entry.progress + throttle 1 notify sau 500ms; done xóa timer", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    const d = deferred<DriveFileItem>();
    uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
      opts.onProgress?.(0.42);
      return d.promise;
    });
    const cb = vi.fn();
    um.subscribe(cb);

    um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
    await realTick();

    expect(um.getEntries()[0]?.progress).toBe(0.42);
    // queued-push + uploading only — the progress update sits in the throttled
    // timer, subscribers are NOT spammed per chunk.
    expect(cb).toHaveBeenCalledTimes(2);

    await advanceBackoff(500);
    expect(cb).toHaveBeenCalledTimes(3); // one throttled progress notify

    d.resolve(makeDriveFile("f1", "x.mp3"));
    await realTick(12);
    expect(cb).toHaveBeenCalledTimes(4); // done notify fires immediately
    // The 10s 'uploaded' tint timer is intentional (auto-clears) — the progress timer itself is gone.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("chunked upload throw → stream.close vẫn được gọi (finally)", async () => {
    uploadFileResumableChunked.mockRejectedValueOnce(
      new UploadErrorClass("network down", "network"),
    );
    const snapshots = captureSnapshots();

    um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
    await waitIdle();

    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "error", error: "network" },
    ]);
    const firstResult = openDiskReadStream.mock.results[0];
    if (firstResult === undefined)
      throw new Error("expected stream open result");
    const stream = (await firstResult.value) as {
      close: ReturnType<typeof vi.fn>;
    };
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("chunked 308-rewind: readChunk offset < vị trí stream → reopen stream mới từ đầu", async () => {
    const s1 = {
      read: vi
        .fn()
        .mockResolvedValueOnce(new Uint8Array([1, 2]))
        .mockResolvedValueOnce(null),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const s2 = {
      read: vi
        .fn()
        .mockResolvedValueOnce(new Uint8Array([3, 4]))
        .mockResolvedValueOnce(null),
      close: vi.fn().mockResolvedValue(undefined),
    };
    openDiskReadStream.mockResolvedValueOnce(s1).mockResolvedValueOnce(s2);
    const chunks: Uint8Array[] = [];
    uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
      // Simulates a 308-without-Range resume: the session asks for offset 0
      // again after the stream already consumed 2 bytes.
      const first = await opts.readChunk(0);
      const second = await opts.readChunk(0);
      if (first === null || second === null) throw new Error("expected chunk");
      chunks.push(first);
      chunks.push(second);
      return makeDriveFile("f1", "x.mp3");
    });

    um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
    await waitIdle();

    expect(openDiskReadStream).toHaveBeenCalledTimes(2);
    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(s2.close).toHaveBeenCalledTimes(1); // via the outer finally
    if (chunks[0] === undefined || chunks[1] === undefined)
      throw new Error("expected chunks");
    expect(Array.from(chunks[0])).toEqual([1, 2]);
    expect(Array.from(chunks[1])).toEqual([3, 4]);
  });

  it("chunked 308 partial-ack giữa chunk: skip overshoot → trả remainder bắt đầu ĐÚNG offset (không lệch vị trí)", async () => {
    // Stream chunks encode their absolute file position in byte values so a
    // misaligned read is immediately visible: chunk0 = [0..7], chunk1 = [8..15].
    const chunk0 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const chunk1 = new Uint8Array([8, 9, 10, 11, 12, 13, 14, 15]);
    const s1 = {
      read: vi
        .fn()
        .mockResolvedValueOnce(chunk0)
        .mockResolvedValueOnce(chunk1)
        .mockResolvedValueOnce(null),
      close: vi.fn().mockResolvedValue(undefined),
    };
    // After the reopen the same file content is replayed from the start.
    const s2 = {
      read: vi
        .fn()
        .mockResolvedValueOnce(chunk0)
        .mockResolvedValueOnce(chunk1)
        .mockResolvedValueOnce(null),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const s3 = {
      read: vi
        .fn()
        .mockResolvedValueOnce(chunk0)
        .mockResolvedValueOnce(chunk1)
        .mockResolvedValueOnce(null),
      close: vi.fn().mockResolvedValue(undefined),
    };
    // First two opens are explicit; any further reopen falls back to s3 (the
    // old buggy code reopens on every readChunk rewind). mockResolvedValue
    // (not Once) so no queued mock leaks into the next test.
    openDiskReadStream
      .mockResolvedValueOnce(s1)
      .mockResolvedValueOnce(s2)
      .mockResolvedValue(s3);
    const seen: Array<Uint8Array | null> = [];
    uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
      // Simulates a 308 resume where the server acked only 3 of the 8 bytes
      // it actually received: the next read must start at byte 3, not at the
      // next stream boundary (byte 8).
      seen.push(await opts.readChunk(0));
      seen.push(await opts.readChunk(3));
      seen.push(await opts.readChunk(8));
      return makeDriveFile("f1", "x.mp3");
    });

    um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
    await waitIdle();

    expect(seen[0]).toEqual(chunk0);
    expect(seen[1]).toEqual(new Uint8Array([3, 4, 5, 6, 7]));
    expect(seen[2]).toEqual(chunk1);
  });

  it("file growth: totalSize từ stat.size, readChunk không truncate ở tầng manager", async () => {
    statDiskPath.mockResolvedValue({
      path: "C:/grow.mp3",
      name: "grow.mp3",
      relativePath: "grow.mp3",
      isDirectory: false,
      size: 100,
    });
    const seq = (start: number, len: number) =>
      new Uint8Array(Array.from({ length: len }, (_, i) => start + i));
    openDiskReadStream.mockResolvedValue({
      read: vi
        .fn()
        .mockResolvedValueOnce(seq(0, 64)) // bytes 0..63
        .mockResolvedValueOnce(seq(64, 64)) // bytes 64..127 — stream outlives the announced size
        .mockResolvedValueOnce(null),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const reads: Array<Uint8Array | null> = [];
    uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
      reads.push(await opts.readChunk(0));
      reads.push(await opts.readChunk(64));
      return makeDriveFile("f1", "grow.mp3");
    });

    um.startUploads([diskFileSeed("x", "C:/grow.mp3")], TOKEN);
    await waitIdle();

    expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
    expect(uploadFileResumableChunked.mock.calls[0]?.[1]?.totalSize).toBe(100);
    // readChunk stays a pure reader — overshoot handling lives in driveApi.
    expect(reads[0]).toEqual(seq(0, 64));
    expect(reads[1]).toEqual(seq(64, 64));
  });

  it("getUploadState: entry.id đang upload/queued → uploading", async () => {
    const da = deferred<DriveFileItem>();
    const dbB = deferred<DriveFileItem>();
    // Concurrency 2: cả a lẫn b start ngay — cả 2 cần deferred để giữ trạng
    // thái uploading (nếu b resolve ngay, entry b bị prune khỏi danh sách).
    uploadFileResumable
      .mockReturnValueOnce(da.promise)
      .mockReturnValueOnce(dbB.promise);

    um.startUploads([fileSeed("a.mp3"), fileSeed("b.mp3")], TOKEN);
    await flush();

    const entries = um.getEntries();
    const a = entries[0];
    const b = entries[1];
    if (a === undefined || b === undefined)
      throw new Error("expected 2 upload entries");
    expect(um.getUploadState(a.id)).toBe("uploading");
    expect(um.getUploadState(b.id)).toBe("uploading");
    expect(um.getUploadState("unknown-id")).toBe("none");

    da.resolve(makeDriveFile("f1", "a.mp3"));
    dbB.resolve(makeDriveFile("f2", "b.mp3"));
    await waitIdle();
  });

  it("getUploadState: folder batch — con đang upload (parentId=folder driveId) → folder chỉ parent-uploading (hết mờ)", async () => {
    walkDiskFolder.mockResolvedValue([
      {
        path: "C:/Music/a.mp3",
        name: "a.mp3",
        relativePath: "a.mp3",
        isDirectory: false,
        size: 5,
      },
    ]);
    createFolderMock.mockResolvedValue({
      id: "folder-1",
      name: "Album",
      mimeType: FOLDER_MIME,
    });
    const d = deferred<DriveFileItem>();
    uploadFileResumableChunked.mockReturnValueOnce(d.promise);

    um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
    await flush();

    // folder root đã done (driveId='folder-1'); con đang upload với parentId='folder-1'
    // → folder chỉ 'parent-uploading' (hết mờ, giữ spinner) — ADR deviation đã chốt.
    expect(um.getUploadState("folder-1")).toBe("parent-uploading");

    d.resolve(makeDriveFile("f-a", "a.mp3"));
    await waitIdle();
  });

  it("getUploadState: parentId → parent-uploading; root không bao giờ parent-uploading", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3", "folder-9")], TOKEN);
    await flush();

    expect(um.getUploadState("folder-9")).toBe("parent-uploading");
    expect(um.getUploadState("root")).toBe("none");

    d.resolve(makeDriveFile("f9", "s.mp3"));
    await waitIdle();
  });

  it("getUploadState: sau done → none", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await flush();
    const firstEntry = um.getEntries()[0];
    if (!firstEntry) throw new Error("expected upload entry");
    const id = firstEntry.id;
    expect(um.getUploadState(id)).toBe("uploading");

    d.resolve(makeDriveFile("f9", "s.mp3"));
    await waitIdle();
    expect(um.getUploadState(id)).toBe("none");
  });

  it("getUploadState: sau done → uploaded (check xanh qua driveId); dismissUploaded → none ngay; pending id đã prune → none", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await flush();
    const firstEntry = um.getEntries()[0];
    if (!firstEntry) throw new Error("expected upload entry");
    const entryId = firstEntry.id;

    d.resolve(makeDriveFile("f9", "s.mp3"));
    await waitIdle();

    // markRecentlyDone nhận driveId — cái id live list biết item bằng — nên
    // check hiển cho driveId; pending id (entry đã bị prune) trả về none.
    expect(um.getUploadState("f9")).toBe("uploaded");
    expect(um.getUploadState(entryId)).toBe("none");

    // Click play → dismissUploaded → row về idle MoreMenu ngay (không chờ 10s).
    um.dismissUploaded("f9");
    expect(um.getUploadState("f9")).toBe("none");
  });

  it("clearUploadedTint: xóa toàn bộ check uploaded ngay + notify đúng 1 lần; set rỗng → no-op không notify thừa", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    const cb = vi.fn();
    um.subscribe(cb);

    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await flush();
    d.resolve(makeDriveFile("f9", "s.mp3"));
    await waitIdle();
    expect(um.getUploadState("f9")).toBe("uploaded");

    const notifiesBefore = cb.mock.calls.length;
    um.clearUploadedTint();
    expect(um.getUploadState("f9")).toBe("none");
    expect(cb).toHaveBeenCalledTimes(notifiesBefore + 1);

    // Đã rỗng → gọi lần nữa không notify thừa (cùng pattern dismissUploaded).
    um.clearUploadedTint();
    expect(cb).toHaveBeenCalledTimes(notifiesBefore + 1);
  });

  it("uploaded tint tự hết sau 10s qua timer; dismissUploaded id không nằm trong set → no-op không throw", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await realTick();
    d.resolve(makeDriveFile("f9", "s.mp3"));
    await realTick(12);

    expect(um.getUploadState("f9")).toBe("uploaded");

    // Chỉ còn đúng 1 timer: tint 10s (auto-clears, không leak).
    expect(vi.getTimerCount()).toBe(1);
    await advanceBackoff(10_000);
    expect(um.getUploadState("f9")).toBe("none");
    expect(vi.getTimerCount()).toBe(0);

    expect(() => {
      um.dismissUploaded("f9");
    }).not.toThrow();
    expect(um.getUploadState("f9")).toBe("none");
  });

  it("createFolder subfolder fail → subfolder error; file con trong đó → parent-folder-missing", async () => {
    walkDiskFolder.mockResolvedValue([
      {
        path: "C:/Music/sub",
        name: "sub",
        relativePath: "sub",
        isDirectory: true,
        size: 0,
      },
      {
        path: "C:/Music/sub/x.mp3",
        name: "x.mp3",
        relativePath: "sub/x.mp3",
        isDirectory: false,
        size: 5,
      },
    ]);
    createFolderMock.mockImplementation((_t, name) => {
      if (name === "Album")
        return Promise.resolve({ id: "folder-1", name, mimeType: FOLDER_MIME });
      return Promise.reject(new Error("create failed (400)"));
    });
    const snapshots = captureSnapshots();

    um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
    await waitIdle();

    // Terminal entries are pruned, so per-entry error kinds come from the
    // captureError logs markError emits (name + kind, no path/token).
    const messages = captureError.mock.calls.map((c) => c[0].message);
    expect(messages).toEqual([
      expect.stringContaining("name=sub kind=failed"),
      expect.stringContaining("name=x.mp3 kind=parent-folder-missing"),
    ]);
    // Album itself reached 'done' (its terminal notify preceded sub/x.mp3).
    expect(snapshots.some((s) => s[0]?.status === "done")).toBe(true);
    expect(um.getEntries()).toEqual([]);
    expect(uploadFileResumable).not.toHaveBeenCalled();
  });

  it("A. prune: 3 file bytes upload xong → getEntries trả [] (không giữ entry terminal)", async () => {
    um.startUploads(
      [fileSeed("a.mp3"), fileSeed("b.mp3"), fileSeed("c.mp3")],
      TOKEN,
    );
    await waitIdle();

    expect(um.getEntries()).toEqual([]);
    expect(um.getUploadingIds().size).toBe(0);
  });

  it("B. prune: entry error (UploadError invalid) → getEntries trả []", async () => {
    uploadFileResumable.mockRejectedValueOnce(
      new UploadErrorClass("bad request (400)", "invalid"),
    );

    um.startUploads([fileSeed("x.mp3")], TOKEN);
    await waitIdle();

    expect(um.getEntries()).toEqual([]);
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "uploadManager" }),
    );
  });

  it("B2. UploadError invalid → log gồm name + kind + message UploadError (status 4xx)", async () => {
    uploadFileResumable.mockRejectedValueOnce(
      new UploadErrorClass("upload failed (status=400)", "invalid"),
    );

    um.startUploads([fileSeed("x.mp3")], TOKEN);
    await waitIdle();

    const message = captureError.mock.calls.map((c) => c[0].message).join("\n");
    expect(message).toContain("name=x.mp3");
    expect(message).toContain("kind=invalid");
    expect(message).toContain("status=400");
  });

  it("B3. Plain Error từ diskFs (message chứa full disk path) → log chỉ name+kind, không lộ path", async () => {
    const fullPath = "C:\\Music\\Secret Album\\track.flac";
    openDiskReadStream.mockRejectedValue(
      new Error(`EACCES: permission denied, open '${fullPath}'`),
    );

    um.startUploads([diskFileSeed("x", fullPath)], TOKEN);
    await waitIdle();

    const message = captureError.mock.calls.map((c) => c[0].message).join("\n");
    expect(message).toContain("name=track.flac");
    expect(message).toContain("kind=failed");
    expect(message).not.toContain("Secret Album");
  });

  it("C. prune: folder batch (folder + subfolder + 2 files con) xong → getEntries trả []", async () => {
    walkDiskFolder.mockResolvedValue([
      {
        path: "C:/Music/a.mp3",
        name: "a.mp3",
        relativePath: "a.mp3",
        isDirectory: false,
        size: 5,
      },
      {
        path: "C:/Music/sub",
        name: "sub",
        relativePath: "sub",
        isDirectory: true,
        size: 0,
      },
      {
        path: "C:/Music/sub/x.mp3",
        name: "x.mp3",
        relativePath: "sub/x.mp3",
        isDirectory: false,
        size: 5,
      },
      {
        path: "C:/Music/sub/y.mp3",
        name: "y.mp3",
        relativePath: "sub/y.mp3",
        isDirectory: false,
        size: 5,
      },
    ]);
    let fileCounter = 0;
    createFolderMock.mockImplementation((_t, name) =>
      Promise.resolve({
        id: name === "Album" ? "folder-1" : "sub-1",
        name,
        mimeType: FOLDER_MIME,
      }),
    );
    uploadFileResumableChunked.mockImplementation((_t, opts) =>
      Promise.resolve(
        makeDriveFile(`file-${String(++fileCounter)}`, opts.name),
      ),
    );

    um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
    await waitIdle();

    expect(uploadFileResumableChunked).toHaveBeenCalledTimes(3);
    expect(um.getEntries()).toEqual([]);
  });

  it("D. prune không phá queue: startUploads batch 2 sau batch 1 xong → chạy bình thường", async () => {
    um.startUploads([fileSeed("a.mp3")], TOKEN);
    await waitIdle();
    expect(um.getEntries()).toEqual([]);

    um.startUploads([fileSeed("b.mp3"), fileSeed("c.mp3")], TOKEN);
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
    expect(um.getUploadingIds().size).toBe(0);
    expect(um.getEntries()).toEqual([]);
  });

  it("E. prune: sau done, getUploadingIds/isUploading/getUploadState không còn dính entry đã xong", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3", "folder-9")], TOKEN);
    await flush();
    const firstEntry = um.getEntries()[0];
    if (!firstEntry) throw new Error("expected upload entry");
    const entryId = firstEntry.id;

    d.resolve(makeDriveFile("f9", "s.mp3"));
    await waitIdle();

    expect(um.getUploadingIds().size).toBe(0);
    expect(um.isUploading(entryId)).toBe(false);
    expect(um.getUploadState(entryId)).toBe("none");
  });

  describe("cancelUpload", () => {
    it("1. cancel entry đang upload (chunked) → error aborted + không toast + xóa pending row + prune", async () => {
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        // Real driveApi listens on the wired signal and rejects with
        // UploadError('aborted') — mirror that so the manager's markError
        // branch is exercised end-to-end.
        return new Promise<DriveFileItem>((_resolve, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => {
              reject(
                new UploadErrorClass("upload aborted by caller", "aborted"),
              );
            },
            { once: true },
          );
        });
      });

      um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
      await flush();

      const firstEntry = um.getEntries()[0];
      if (!firstEntry) throw new Error("expected upload entry");
      const entryId = firstEntry.id;
      expect(um.getUploadState(entryId)).toBe("uploading");
      // The entry controller's signal must actually be wired into the uploader.
      expect(
        uploadFileResumableChunked.mock.calls[0]?.[1]?.signal,
      ).toBeInstanceOf(AbortSignal);
      expect(await db.files.toArray()).toHaveLength(1); // pending row exists

      um.cancelUpload(entryId);
      await waitIdle();

      expect(um.getEntries()).toEqual([]); // pruned
      expect(showErrorToast).not.toHaveBeenCalled(); // user cancel is not an error
      expect(await db.files.toArray()).toHaveLength(0); // pending row deleted
      const messages = captureError.mock.calls.map((c) => c[0].message);
      expect(messages).toContain("upload-cancelled name=x.mp3");
      const warnLog = captureError.mock.calls.find((c) =>
        c[0].message.includes("upload-cancelled"),
      );
      expect(warnLog?.[0].level).toBe("warn");
      expect(firedEvents("drive-files-changed")).toHaveLength(0);
    });

    it("2. cancel entry queued → không gọi upload API cho nó, error aborted + prune ngay, queue không đụng", async () => {
      const da = deferred<DriveFileItem>();
      const dbB = deferred<DriveFileItem>();
      uploadFileResumable
        .mockReturnValueOnce(da.promise)
        .mockReturnValueOnce(dbB.promise);

      um.startUploads(
        [fileSeed("a.mp3"), fileSeed("b.mp3"), fileSeed("c.mp3")],
        TOKEN,
      );
      await flush();

      // Concurrency 2: a, b đang upload → c nằm queued chờ slot.
      expect(uploadFileResumable).toHaveBeenCalledTimes(2);
      const entries = um.getEntries();
      const a = entries[0];
      const b = entries[1];
      const c = entries[2];
      if (a === undefined || b === undefined || c === undefined)
        throw new Error("expected 3 upload entries");
      expect(c.status).toBe("queued");

      um.cancelUpload(c.id);
      expect(uploadFileResumable).toHaveBeenCalledTimes(2); // c chưa bao giờ start
      expect(um.getEntries().map((e) => e.id)).toEqual([a.id, b.id]); // c bị prune ngay
      expect(showErrorToast).not.toHaveBeenCalled();

      da.resolve(makeDriveFile("f1", "a.mp3"));
      dbB.resolve(makeDriveFile("f2", "b.mp3"));
      await waitIdle();
      expect(uploadFileResumable).toHaveBeenCalledTimes(2); // pump bỏ qua c (đã error)
      expect(um.getEntries()).toEqual([]);
      expect(showErrorToast).not.toHaveBeenCalled();
    });

    it("3. cancel id không tồn tại → no-op không throw, entries không đổi", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumable.mockReturnValueOnce(d.promise);

      um.startUploads([fileSeed("a.mp3")], TOKEN);
      await flush();
      const before = um.getEntries();

      expect(() => {
        um.cancelUpload("unknown-id");
      }).not.toThrow();
      expect(um.getEntries()).toEqual(before);

      d.resolve(makeDriveFile("f1", "a.mp3"));
      await waitIdle();
    });

    it("4. cancel 2 lần liên tiếp → lần 2 no-op (abort idempotent), chỉ 1 lần xử lý aborted", async () => {
      let abortEvents = 0;
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        return new Promise<DriveFileItem>((_resolve, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => {
              abortEvents++;
              reject(
                new UploadErrorClass("upload aborted by caller", "aborted"),
              );
            },
            { once: true },
          );
        });
      });

      um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
      await flush();
      const firstEntry = um.getEntries()[0];
      if (!firstEntry) throw new Error("expected upload entry");
      const id = firstEntry.id;

      um.cancelUpload(id);
      um.cancelUpload(id); // signal đã aborted → abort() là no-op
      await waitIdle();

      expect(abortEvents).toBe(1);
      expect(um.getEntries()).toEqual([]);
      const cancelled = captureError.mock.calls.filter((c) =>
        c[0].message.includes("upload-cancelled"),
      );
      expect(cancelled).toHaveLength(1);
      expect(showErrorToast).not.toHaveBeenCalled();
    });

    it("5. cancel sau khi entry terminal (done) → no-op không throw", async () => {
      um.startUploads([fileSeed("a.mp3")], TOKEN);
      await waitIdle();
      expect(um.getEntries()).toEqual([]);

      expect(() => {
        um.cancelUpload("pending-whatever");
      }).not.toThrow();
    });

    it("6. cancel folder root khi đang walk → aborted + không toast + không createFolder + không enqueue children", async () => {
      walkDiskFolder.mockImplementation(async (_path, signal) => {
        return new Promise<DiskEntry[]>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      });
      const snapshots = captureSnapshots();

      um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
      await flush();

      const firstEntry = um.getEntries()[0];
      if (!firstEntry) throw new Error("expected upload entry");
      const entryId = firstEntry.id;
      expect(walkDiskFolder.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
      expect(um.getUploadState(entryId)).toBe("uploading");

      um.cancelUpload(entryId);
      await waitIdle();

      expect(snapshots[snapshots.length - 1]).toEqual([
        { status: "error", error: "aborted" },
      ]);
      expect(um.getEntries()).toEqual([]);
      expect(createFolderMock).not.toHaveBeenCalled();
      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).not.toHaveBeenCalled();
      const messages = captureError.mock.calls.map((c) => c[0].message);
      expect(messages).toContain("upload-cancelled name=Album");
      expect(await db.files.toArray()).toHaveLength(0);
    });

    it("7. cancel folder root sau walk, trong lúc createFolder → aborted + không enqueue children", async () => {
      walkDiskFolder.mockResolvedValue([
        {
          path: "C:/Music/a.mp3",
          name: "a.mp3",
          relativePath: "a.mp3",
          isDirectory: false,
          size: 5,
        },
        {
          path: "C:/Music/sub",
          name: "sub",
          relativePath: "sub",
          isDirectory: true,
          size: 0,
        },
      ]);
      createFolderMock.mockImplementation(
        async (_t, _name, _parent, signal) => {
          return new Promise<DriveFileItem>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        },
      );
      const snapshots = captureSnapshots();

      um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
      await flush();

      const firstEntry = um.getEntries()[0];
      if (!firstEntry) throw new Error("expected upload entry");
      const entryId = firstEntry.id;
      expect(createFolderMock.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);

      um.cancelUpload(entryId);
      await waitIdle();

      expect(snapshots[snapshots.length - 1]).toEqual([
        { status: "error", error: "aborted" },
      ]);
      expect(um.getEntries()).toEqual([]);
      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).not.toHaveBeenCalled();
      expect(await db.files.toArray()).toHaveLength(0);
    });

    it("8. cancel folder child (đang createFolder subfolder) → child aborted + không toast + file con không upload", async () => {
      walkDiskFolder.mockResolvedValue([
        {
          path: "C:/Music/sub",
          name: "sub",
          relativePath: "sub",
          isDirectory: true,
          size: 0,
        },
        {
          path: "C:/Music/sub/x.mp3",
          name: "x.mp3",
          relativePath: "sub/x.mp3",
          isDirectory: false,
          size: 5,
        },
      ]);
      createFolderMock.mockImplementation(async (_t, name, _parent, signal) => {
        if (name === "Album")
          return { id: "folder-1", name, mimeType: FOLDER_MIME };
        return new Promise<DriveFileItem>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      });

      um.startUploads([folderSeed("Album", "C:/Music")], TOKEN);
      await flush();

      const child = um.getEntries().find((e) => e.name === "sub");
      expect(child).toBeTruthy();
      expect(createFolderMock.mock.calls[1]?.[3]).toBeInstanceOf(AbortSignal);
      if (!child) throw new Error("expected sub entry");

      um.cancelUpload(child.id);
      await waitIdle();

      const messages = captureError.mock.calls.map((c) => c[0].message);
      expect(messages).toContain("upload-cancelled name=sub");
      expect(showErrorToast).not.toHaveBeenCalled();
      // x.mp3's parent subfolder never materialized → it must not upload.
      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(um.getEntries()).toEqual([]);
    });

    it("11. cancel bytes-upload đang retry giữa backoff → không retry tiếp, error aborted", async () => {
      vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
      uploadFileResumable
        .mockRejectedValueOnce(
          new UploadErrorClass("network hiccup", "network"),
        )
        .mockRejectedValueOnce(
          new UploadErrorClass("should never be called", "network"),
        );

      um.startUploads([fileSeed("r.mp3")], TOKEN);
      await realTick();
      expect(uploadFileResumable).toHaveBeenCalledTimes(1);
      expect(uploadFileResumable.mock.calls[0]?.[4]).toBeInstanceOf(
        AbortSignal,
      ); // signal wired

      const firstEntry = um.getEntries()[0];
      if (!firstEntry) throw new Error("expected upload entry");
      const id = firstEntry.id;
      um.cancelUpload(id); // abort trong lúc backoff
      await advanceBackoff(1500); // backoffDelay(attempt-1=0) ∈ [1000, 1500)
      await realTick();

      expect(uploadFileResumable).toHaveBeenCalledTimes(1); // không retry sau abort
      expect(um.getEntries()).toEqual([]);
      expect(
        captureError.mock.calls.some((c) =>
          c[0].message.includes("upload-cancelled"),
        ),
      ).toBe(true);
      expect(showErrorToast).not.toHaveBeenCalled();

      await advanceBackoff(5000);
      expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    });

    it("11b. abort đúng LÚC quyết định retry → thoát NGAY trước backoff (không ngủ trọn Retry-After)", async () => {
      vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
      // Test 11 aborts mid-backoff, so its second queued
      // mockRejectedValueOnce ("should never be called") is NEVER consumed —
      // and clearAllMocks only clears call history, not the once-queue of
      // this cached vi.fn. Drain it first or call #1 below eats that stale
      // rejection instead of our implementation.
      uploadFileResumable.mockReset();
      uploadFileResumable.mockResolvedValue(makeDriveFile("file-x", "x.mp3"));
      // Abort lands synchronously INSIDE the attempt — by the time the
      // rejection reaches uploadWithRetry's catch, signal.aborted is already
      // true, so the retry decision point must bail BEFORE sleeping.
      uploadFileResumable.mockImplementationOnce(() => {
        const e = um.getEntries()[0];
        if (e) um.cancelUpload(e.id);
        return Promise.reject(
          new UploadErrorClass("network down", "network", 429, "3600"),
        );
      });

      um.startUploads([fileSeed("r.mp3")], TOKEN);
      await realTick();
      expect(uploadFileResumable).toHaveBeenCalledTimes(1);

      // Retry-After "3600" is honored as the backoff sleep; a tiny advance
      // must suffice when the pre-sleep guard exits immediately.
      await advanceBackoff(100);
      await realTick();

      expect(uploadFileResumable).toHaveBeenCalledTimes(1); // không retry sau abort
      expect(um.getEntries()).toEqual([]); // settled NGAY — không kẹt trong sleep
      expect(
        captureError.mock.calls.some((c) =>
          c[0].message.includes("upload-cancelled"),
        ),
      ).toBe(true);
      expect(showErrorToast).not.toHaveBeenCalled();

      // Even after the full Retry-After elapses: still exactly one attempt.
      await advanceBackoff(3_600_000);
      expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    });
  });

  describe("getUploadProgress", () => {
    it("10. trả progress fraction của entry uploading; undefined khi chưa có / id lạ / sau done", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        opts.onProgress?.(0.42);
        return d.promise;
      });

      um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
      await flush();

      const firstEntry = um.getEntries()[0];
      if (!firstEntry) throw new Error("expected upload entry");
      const entryId = firstEntry.id;
      expect(um.getUploadProgress(entryId)).toBe(0.42);
      expect(um.getUploadProgress("unknown-id")).toBeUndefined();

      d.resolve(makeDriveFile("f1", "x.mp3"));
      await waitIdle();
      expect(um.getUploadProgress(entryId)).toBeUndefined(); // sau done (pruned)
    });

    it("10b. bytes upload / entry queued (chưa có progress) → undefined", async () => {
      const da = deferred<DriveFileItem>();
      const dbB = deferred<DriveFileItem>();
      // Concurrency 2: cả 2 start — nếu b resolve ngay, entry b bị prune và
      // getEntries()[1] trả undefined (test không còn ý nghĩa).
      uploadFileResumable
        .mockReturnValueOnce(da.promise)
        .mockReturnValueOnce(dbB.promise);

      um.startUploads([fileSeed("a.mp3"), fileSeed("b.mp3")], TOKEN);
      await flush();

      const entries = um.getEntries();
      const a = entries[0];
      const b = entries[1];
      if (a === undefined || b === undefined)
        throw new Error("expected 2 upload entries");
      expect(um.getUploadProgress(a.id)).toBeUndefined(); // uploading nhưng chưa có progress
      expect(um.getUploadProgress(b.id)).toBeUndefined(); // uploading nhưng chưa có progress

      da.resolve(makeDriveFile("f1", "a.mp3"));
      dbB.resolve(makeDriveFile("f2", "b.mp3"));
      await waitIdle();
    });
  });

  describe("progress throttle", () => {
    it("6. onProgress 3 lần nhanh → coalesce 1 notify sau 500ms; đợt 2 cách >500ms → notify thứ 2", async () => {
      vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
      const d = deferred<DriveFileItem>();
      let onProgress: ((f: number) => void) | undefined;
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        onProgress = opts.onProgress;
        opts.onProgress?.(0.3);
        opts.onProgress?.(0.6);
        opts.onProgress?.(0.9);
        return d.promise;
      });
      const cb = vi.fn();
      um.subscribe(cb);

      um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
      await realTick();

      expect(um.getEntries()[0]?.progress).toBe(0.9);
      expect(cb).toHaveBeenCalledTimes(2); // queued + uploading — burst đang chờ timer
      await advanceBackoff(500);
      expect(cb).toHaveBeenCalledTimes(3); // 3 onProgress nhanh → đúng 1 notify

      onProgress?.(0.95); // đợt 2, cách > 500ms
      expect(cb).toHaveBeenCalledTimes(3);
      await advanceBackoff(500);
      expect(cb).toHaveBeenCalledTimes(4); // notify thứ 2

      d.resolve(makeDriveFile("f1", "x.mp3"));
      await realTick(12);
      expect(cb).toHaveBeenCalledTimes(5); // done notify NGAY, không bị delay bởi throttle
      expect(vi.getTimerCount()).toBe(1); // +1 tint timer (10s, auto-clears)
    });

    it("7. progress không đổi → không notify thừa (1 notify duy nhất cho cùng giá trị)", async () => {
      vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
      const d = deferred<DriveFileItem>();
      let onProgress: ((f: number) => void) | undefined;
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        onProgress = opts.onProgress;
        opts.onProgress?.(0.5);
        opts.onProgress?.(0.5);
        return d.promise;
      });
      const cb = vi.fn();
      um.subscribe(cb);

      um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
      await realTick();
      await advanceBackoff(500);
      expect(cb).toHaveBeenCalledTimes(3); // 2 baseline + đúng 1 notify (coalesce cùng giá trị)

      onProgress?.(0.5); // cùng giá trị lặp lại
      await advanceBackoff(500);
      expect(cb).toHaveBeenCalledTimes(3); // không notify thêm

      d.resolve(makeDriveFile("f1", "x.mp3"));
      await realTick(12);
      expect(cb).toHaveBeenCalledTimes(4); // done notify
      expect(vi.getTimerCount()).toBe(1); // +1 tint timer (10s, auto-clears)
    });

    it("9. timer dọn khi entry done — không còn pending timer (tránh leak)", async () => {
      vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        opts.onProgress?.(0.5);
        return d.promise;
      });

      um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
      await realTick();
      expect(vi.getTimerCount()).toBe(1); // progress timer đang chờ

      d.resolve(makeDriveFile("f1", "x.mp3"));
      await realTick(12);
      expect(vi.getTimerCount()).toBe(1); // progress cleared — only the 10s tint timer remains
      expect(um.getEntries()).toEqual([]);
    });
  });

  describe("pre-check 5TB (Google Drive max file size)", () => {
    // Just over Google's documented 5 TB per-file limit (binary TB, the same
    // 1024^n family the quota logic already uses).
    const OVER_5TB = 5 * 1024 ** 4 + 1;

    it("(a) disk path: stat.size > 5TB → error too-large + toast rõ + KHÔNG stream/upload/quota-fetch", async () => {
      statDiskPath.mockResolvedValue({
        path: "C:/huge.flac",
        name: "huge.flac",
        relativePath: "huge.flac",
        isDirectory: false,
        size: OVER_5TB,
      });
      const snapshots = captureSnapshots();

      um.startUploads([diskFileSeed("x", "C:/huge.flac")], TOKEN);
      await waitIdle();

      expect(snapshots[snapshots.length - 1]).toEqual([
        { status: "error", error: "too-large" },
      ]);
      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(openDiskReadStream).not.toHaveBeenCalled();
      expect(generateClientId).not.toHaveBeenCalled();
      // Fail-early: bị chặn TRƯỚC cả quota fetch — không 1 network call nào.
      expect(getDriveStorageQuota).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledWith("upload.too_large");
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      // Log warn kèm size, không lộ disk path.
      const logs = captureError.mock.calls.map((c) => c[0]);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe("warn");
      expect(logs[0]?.message).toContain("name=huge.flac");
      expect(logs[0]?.message).toContain("size=");
      expect(logs[0]?.message).not.toContain("C:/");
      expect(await db.files.toArray()).toHaveLength(0);
    });

    it("(b) bytes path: seed bytes > 5TB → error too-large + toast + KHÔNG uploadFileResumable", async () => {
      // Blob.size là getter ở prototype — override ở subclass để mô phỏng kích
      // thước 5TB mà không allocate 5.5e12 byte thật.
      class HugeBlob extends Blob {
        override get size(): number {
          return OVER_5TB;
        }
      }
      const snapshots = captureSnapshots();

      um.startUploads(
        [
          {
            name: "huge.bin",
            isFolder: false,
            parentId: "root",
            bytes: new HugeBlob([new Uint8Array([1, 2, 3])]),
          },
        ],
        TOKEN,
      );
      await waitIdle();

      expect(snapshots[snapshots.length - 1]).toEqual([
        { status: "error", error: "too-large" },
      ]);
      expect(uploadFileResumable).not.toHaveBeenCalled();
      expect(generateClientId).not.toHaveBeenCalled();
      expect(getDriveStorageQuota).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledWith("upload.too_large");
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(await db.files.toArray()).toHaveLength(0);
    });

    it("(c) file bình thường (100GB) → upload chạy bình thường, không đổi luồng", async () => {
      const gb100 = 100 * 1024 ** 3;
      statDiskPath.mockResolvedValue({
        path: "C:/big.flac",
        name: "big.flac",
        relativePath: "big.flac",
        isDirectory: false,
        size: gb100,
      });
      const snapshots = captureSnapshots();

      um.startUploads([diskFileSeed("x", "C:/big.flac")], TOKEN);
      await waitIdle();

      expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
        "done",
      ]);
      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      expect(uploadFileResumableChunked.mock.calls[0]?.[1]?.totalSize).toBe(
        gb100,
      );
      expect(showErrorToast).not.toHaveBeenCalled();
    });

    it("(d) chặn >5TB kể cả khi quota unlimited (limit=null) — pre-check độc lập quota fetch", async () => {
      // Default mock đã là unlimited; khẳng định lại tường minh cho (d).
      getDriveStorageQuota.mockResolvedValue({
        limit: null,
        usage: 0,
        usageInDrive: 0,
        usageInDriveTrash: 0,
      });
      statDiskPath.mockResolvedValue({
        path: "C:/huge.flac",
        name: "huge.flac",
        relativePath: "huge.flac",
        isDirectory: false,
        size: OVER_5TB,
      });

      um.startUploads([diskFileSeed("x", "C:/huge.flac")], TOKEN);
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(getDriveStorageQuota).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledWith("upload.too_large");
    });

    it("(e) i18n: key upload.too_large tồn tại ở en + vi (kèm con số 5 TB)", () => {
      expect(enTranslations.upload.too_large).toContain("5 TB");
      expect(viTranslations.upload.too_large).toContain("5 TB");
    });
  });

  describe("uploadSessions persist lifecycle (slice 5.1)", () => {
    const USER = "user@test.com";

    beforeEach(() => {
      localStorage.setItem(USER_EMAIL_KEY, USER);
    });

    afterEach(() => {
      localStorage.removeItem(USER_EMAIL_KEY);
    });

    it("(a) processEntry persists an active row with entry fields (kind/diskPath/status/userEmail)", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);

      um.startUploads(
        [diskFileSeed("Track One.mp3", "C:/Music/Track One.mp3")],
        TOKEN,
      );
      await flush();

      const entry = um.getEntries()[0];
      if (!entry) throw new Error("expected upload entry");
      const rows = await db.uploadSessions.toArray();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.id).toBe(entry.id);
      expect(row?.userEmail).toBe(USER);
      expect(row?.name).toBe("Track One.mp3");
      expect(row?.isFolder).toBe(false);
      expect(row?.kind).toBe("diskFile");
      expect(row?.diskPath).toBe("C:/Music/Track One.mp3");
      expect(row?.parentId).toBe("root");
      expect(row?.status).toBe("active");
      expect(typeof row?.createdAt).toBe("number");
      expect(typeof row?.updatedAt).toBe("number");

      d.resolve(makeDriveFile("f1", "Track One.mp3"));
      await waitIdle();
    });

    it("(a2) enriching the active row keeps the original createdAt (resumeInterruptedUploads sorts oldest-first = original order)", async () => {
      const uploadGate = deferred<DriveFileItem>();
      const statGate = deferred<DiskEntry>();
      uploadFileResumableChunked.mockReturnValueOnce(uploadGate.promise);
      statDiskPath.mockReturnValueOnce(statGate.promise);

      const dateSpy = vi.spyOn(Date, "now");
      dateSpy.mockReturnValue(1_000_000);
      um.startUploads(
        [diskFileSeed("Track One.mp3", "C:/Music/Track One.mp3")],
        TOKEN,
      );
      // The base persist (processEntry) lands at t=1_000_000, then the upload
      // blocks on the deferred stat before its totalSize enrich.
      await flush();
      dateSpy.mockReturnValue(9_000_000);
      statGate.resolve({
        path: "C:/Music/Track One.mp3",
        name: "Track One.mp3",
        relativePath: "Track One.mp3",
        isDirectory: false,
        size: 2,
      });
      await flush();

      const rows = await db.uploadSessions.toArray();
      expect(rows).toHaveLength(1);
      // A Dexie put replaces the whole row — the enrich put must carry the
      // FIRST write's createdAt forward instead of stamping a new one.
      expect(rows[0]?.createdAt).toBe(1_000_000);

      dateSpy.mockRestore();
      uploadGate.resolve(makeDriveFile("f1", "Track One.mp3"));
      await waitIdle();
    });

    it("(b) markDone clears the session row", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumable.mockReturnValueOnce(d.promise);

      um.startUploads([fileSeed("song.mp3")], TOKEN);
      await flush();
      expect(await db.uploadSessions.toArray()).toHaveLength(1);

      d.resolve(makeDriveFile("f1", "song.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(c) markError clears the session row", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumable.mockReturnValueOnce(d.promise);

      um.startUploads([fileSeed("x.mp3")], TOKEN);
      await flush();
      expect(await db.uploadSessions.toArray()).toHaveLength(1);

      d.reject(new UploadErrorClass("bad request (400)", "invalid"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(d1) cancel queued → no session row remains (delete of a never-persisted id is a safe no-op)", async () => {
      const da = deferred<DriveFileItem>();
      const dbB = deferred<DriveFileItem>();
      uploadFileResumable
        .mockReturnValueOnce(da.promise)
        .mockReturnValueOnce(dbB.promise);

      um.startUploads(
        [fileSeed("a.mp3"), fileSeed("b.mp3"), fileSeed("c.mp3")],
        TOKEN,
      );
      await flush();

      // Concurrency 2: a, b đang upload → c nằm queued (chưa bao giờ persist
      // session row — cancel nó phải là delete no-op an toàn).
      const c = um.getEntries().find((e) => e.name === "c.mp3");
      if (!c) throw new Error("expected queued entry");
      expect(c.status).toBe("queued");
      // Hai upload đang chạy sở hữu 2 rows; entry queued chưa persist row nào.
      expect(await db.uploadSessions.toArray()).toHaveLength(2);

      expect(() => {
        um.cancelUpload(c.id);
      }).not.toThrow();
      expect(
        await db.uploadSessions.where("id").equals(c.id).toArray(),
      ).toHaveLength(0);

      da.resolve(makeDriveFile("f1", "a.mp3"));
      dbB.resolve(makeDriveFile("f2", "b.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(d2) cancel in-flight (aborted) clears the session row", async () => {
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        return new Promise<DriveFileItem>((_resolve, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => {
              reject(
                new UploadErrorClass("upload aborted by caller", "aborted"),
              );
            },
            { once: true },
          );
        });
      });

      um.startUploads([diskFileSeed("x", "C:/x.mp3")], TOKEN);
      await flush();
      expect(await db.uploadSessions.toArray()).toHaveLength(1);

      const firstEntry = um.getEntries()[0];
      if (!firstEntry) throw new Error("expected upload entry");
      um.cancelUpload(firstEntry.id);
      await waitIdle();

      expect(await db.uploadSessions.toArray()).toHaveLength(0);
      expect(showErrorToast).not.toHaveBeenCalled();
    });

    it("(e) db.uploadSessions.put reject → upload still done + warn session-persist-failed + no toast", async () => {
      const freshDb = await import("../db/db");
      const putSpy = vi
        .spyOn(freshDb.db.uploadSessions, "put")
        .mockRejectedValue(new Error("db closed"));
      const snapshots = captureSnapshots();

      um.startUploads([fileSeed("song.mp3")], TOKEN);
      await waitIdle();

      expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
        "done",
      ]);
      expect(uploadFileResumable).toHaveBeenCalledTimes(1);
      expect(showErrorToast).not.toHaveBeenCalled();
      const warnCall = captureError.mock.calls.find((c) =>
        c[0].message.includes("session-persist-failed"),
      );
      expect(warnCall).toBeTruthy();
      expect(warnCall?.[0].level).toBe("warn");
      expect(warnCall?.[0].message).toContain(
        "session-persist-failed name=song.mp3",
      );
      putSpy.mockRestore();
    });

    it("(f) bytes seed persists kind='bytes' without diskPath/uploadUri", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumable.mockReturnValueOnce(d.promise);

      um.startUploads([fileSeed("blob.mp3")], TOKEN);
      await flush();

      const rows = await db.uploadSessions.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("bytes");
      expect(rows[0]?.diskPath).toBeUndefined();
      expect(rows[0]?.uploadUri).toBeUndefined();

      d.resolve(makeDriveFile("f1", "blob.mp3"));
      await waitIdle();
    });
  });

  describe("resumeInterruptedUploads (slice 5.2)", () => {
    const USER = "user@test.com";
    const OLD_URI =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=old-session";

    beforeEach(() => {
      localStorage.setItem(USER_EMAIL_KEY, USER);
    });

    afterEach(() => {
      localStorage.removeItem(USER_EMAIL_KEY);
    });

    async function insertSessionRow(row: {
      id: string;
      name: string;
      kind:
        "diskFile" | "folderChildFile" | "folderRoot" | "folderChild" | "bytes";
      diskPath?: string;
      parentId?: string;
      totalSize?: number;
      uploadUri?: string;
      clientGeneratedId?: string;
      userEmail?: string;
      updatedAt?: number;
    }): Promise<void> {
      await db.uploadSessions.put({
        id: row.id,
        userEmail: row.userEmail ?? USER,
        name: row.name,
        isFolder: row.kind === "folderRoot" || row.kind === "folderChild",
        kind: row.kind,
        ...(row.diskPath !== undefined ? { diskPath: row.diskPath } : {}),
        parentId: row.parentId ?? "root",
        ...(row.totalSize !== undefined ? { totalSize: row.totalSize } : {}),
        ...(row.uploadUri !== undefined ? { uploadUri: row.uploadUri } : {}),
        ...(row.clientGeneratedId !== undefined
          ? { clientGeneratedId: row.clientGeneratedId }
          : {}),
        status: "active",
        createdAt: 1,
        // Fresh by default — the TTL guard must never expire the rows of the
        // existing resume tests (only TTL-specific tests pass an old stamp).
        updatedAt: row.updatedAt ?? Date.now(),
      });
    }

    it("(e) diskFile row with a session URI → entry resumes with initialUploadUri + persisted clientGeneratedId, old row deleted, pump uploads", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);
      await insertSessionRow({
        id: "pending-old-1",
        name: "a.mp3",
        kind: "diskFile",
        diskPath: "C:/a.mp3",
        totalSize: 2, // matches the default statDiskPath mock
        uploadUri: OLD_URI,
        clientGeneratedId: "gen-old",
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      // The old row was deleted at resume time; processEntry persisted a NEW
      // active row for the resumed entry (fresh id, no URI yet).
      expect(await db.uploadSessions.toArray()).toHaveLength(1);
      const opts = uploadFileResumableChunked.mock.calls[0]?.[1];
      expect(opts?.initialUploadUri).toBe(OLD_URI);
      expect(opts?.clientGeneratedId).toBe("gen-old");
      expect(opts?.onSessionUpdate).toBeTypeOf("function");
      // The persisted id is reused — no fresh generateClientId call.
      expect(generateClientId).not.toHaveBeenCalled();

      d.resolve(makeDriveFile("f1", "a.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("R5. resumed diskFile nhận pending row ngay tại enqueue (qua bulkPut, không chờ pump xử lý)", async () => {
      // vi.resetModules() in beforeEach gives the queue a FRESH DriveDatabase
      // instance — spy the freshly-imported one (same pattern as slice-5.1 (e)).
      const freshDb = await import("../db/db");
      const putSpy = vi
        .spyOn(freshDb.db.files, "put")
        .mockRejectedValue(new Error("db closed"));
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);
      await insertSessionRow({
        id: "pending-old-r5",
        name: "a.mp3",
        kind: "diskFile",
        diskPath: "C:/a.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      // processEntry's put bị chặn — row chỉ có thể đến từ enqueue-time
      // bulkPut → chứng minh resumed entry được publish ngay khi resume.
      const rows = await db.files.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("a.mp3");
      expect(rows[0]?.id).toMatch(/^pending-/);

      putSpy.mockRestore();
      d.resolve(makeDriveFile("f1", "a.mp3"));
      await waitIdle();
    });

    it("(f) stat null on resume (file deleted/moved/renamed) → entry failed + toast upload.resume_not_found + old row deleted", async () => {
      statDiskPath.mockResolvedValue(null);
      const snapshots = captureSnapshots();
      await insertSessionRow({
        id: "pending-old-2",
        name: "gone.mp3",
        kind: "diskFile",
        diskPath: "C:/gone.mp3",
        uploadUri: OLD_URI,
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).toHaveBeenCalledWith("upload.resume_not_found");
      expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
        "error",
      ]);
      expect(snapshots[snapshots.length - 1]?.[0]?.error).toBe("failed");
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
      const failedLog = captureError.mock.calls.find((c) =>
        c[0].message.includes("reason=resume-file-missing"),
      );
      expect(failedLog).toBeTruthy();
    });

    it("(g) stat.size != persisted totalSize → session dropped: chunked called without initialUploadUri (silent fresh upload)", async () => {
      await insertSessionRow({
        id: "pending-old-3",
        name: "changed.mp3",
        kind: "diskFile",
        diskPath: "C:/changed.mp3",
        totalSize: 999, // stat (default mock) says 2 → mismatch
        uploadUri: OLD_URI,
        clientGeneratedId: "gen-old",
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await waitIdle();

      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      const opts = uploadFileResumableChunked.mock.calls[0]?.[1];
      expect(opts?.initialUploadUri).toBeUndefined();
      // The old pre-generated id is dropped too: a same-id retry could resolve
      // DONE against a stale server-side file of the OLD size.
      expect(generateClientId).toHaveBeenCalledTimes(1);
      expect(showErrorToast).not.toHaveBeenCalled();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(h) two bytes rows → ONE aggregated toast upload.interrupted, no entries, rows deleted", async () => {
      await insertSessionRow({
        id: "pending-old-b1",
        name: "b1.mp3",
        kind: "bytes",
      });
      await insertSessionRow({
        id: "pending-old-b2",
        name: "b2.mp3",
        kind: "bytes",
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).toHaveBeenCalledWith("upload.interrupted");
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(i) concurrent resumeInterruptedUploads calls run once (module guard)", async () => {
      uploadFileResumableChunked.mockImplementation(
        () => new Promise<DriveFileItem>(() => {}),
      );
      await insertSessionRow({
        id: "pending-old-4",
        name: "a.mp3",
        kind: "diskFile",
        diskPath: "C:/a.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
      });

      const p1 = um.resumeInterruptedUploads(TOKEN, USER);
      const p2 = um.resumeInterruptedUploads(TOKEN, USER);
      await Promise.all([p1, p2]);
      await flush();

      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
    });

    it("(j) only the requested user's rows are resumed (per-user isolation)", async () => {
      await insertSessionRow({
        id: "pending-other",
        name: "other.mp3",
        kind: "diskFile",
        diskPath: "C:/other.mp3",
        userEmail: "other@test.com",
        uploadUri: OLD_URI,
      });

      await um.resumeInterruptedUploads(TOKEN, "b@test.com");
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).not.toHaveBeenCalled();
      const rows = await db.uploadSessions.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userEmail).toBe("other@test.com");
    });

    it("(d2) onSessionUpdate from the chunked uploader persists uploadUri + totalSize on the active row", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        opts.onSessionUpdate?.(OLD_URI);
        return d.promise;
      });

      um.startUploads([diskFileSeed("a.mp3", "C:/a.mp3")], TOKEN);
      await flush();

      const rows = await db.uploadSessions.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.uploadUri).toBe(OLD_URI);
      expect(rows[0]?.totalSize).toBe(2); // stat size from the default mock

      d.resolve(makeDriveFile("f1", "a.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(k) folderChildFile row with a resolved parent + session URI resumes into the persisted Drive parent", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);
      await insertSessionRow({
        id: "pending-old-cf",
        name: "child.flac",
        kind: "folderChildFile",
        diskPath: "C:/fold/child.flac",
        parentId: "drive-folder-9", // real Drive id — resolved before the original initiate
        totalSize: 2,
        uploadUri: OLD_URI,
        clientGeneratedId: "gen-cf",
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      const opts = uploadFileResumableChunked.mock.calls[0]?.[1];
      expect(opts?.initialUploadUri).toBe(OLD_URI);
      expect(opts?.parentId).toBe("drive-folder-9");
      expect(opts?.clientGeneratedId).toBe("gen-cf");

      d.resolve(makeDriveFile("f1", "child.flac"));
      await waitIdle();
    });

    it("(k2) folderChildFile row WITHOUT a session URI (parent never resolved) → interrupted, no entry", async () => {
      await insertSessionRow({
        id: "pending-old-cf2",
        name: "child2.flac",
        kind: "folderChildFile",
        diskPath: "C:/fold/child2.flac",
        parentId: "root", // placeholder — the batch root parent, not a Drive id
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).toHaveBeenCalledWith("upload.interrupted");
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(k3) folderRoot rows are NOT re-uploaded (re-walking would duplicate the Drive folder) → interrupted", async () => {
      await insertSessionRow({
        id: "pending-old-fr",
        name: "myfolder",
        kind: "folderRoot",
        diskPath: "C:/myfolder",
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(walkDiskFolder).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).toHaveBeenCalledWith("upload.interrupted");
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(ttl1) diskFile row updatedAt = now - 8 days → expired session → null → interrupted toast + row deleted, no resume", async () => {
      await insertSessionRow({
        id: "pending-old-ttl1",
        name: "old.mp3",
        kind: "diskFile",
        diskPath: "C:/old.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
        // 8 days: one full day past the 7-day TTL.
        updatedAt: Date.now() - (UPLOAD_SESSION_TTL_MS + 24 * 60 * 60 * 1000),
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).toHaveBeenCalledWith("upload.interrupted");
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(ttl2) diskFile row updatedAt = now - (7 days - 1 min) → just under the TTL → resumes with the session URI", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);
      await insertSessionRow({
        id: "pending-old-ttl2",
        name: "fresh.mp3",
        kind: "diskFile",
        diskPath: "C:/fresh.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
        updatedAt: Date.now() - (UPLOAD_SESSION_TTL_MS - 60 * 1000),
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      const opts = uploadFileResumableChunked.mock.calls[0]?.[1];
      expect(opts?.initialUploadUri).toBe(OLD_URI);
      expect(showErrorToast).not.toHaveBeenCalled();

      d.resolve(makeDriveFile("f1", "fresh.mp3"));
      await waitIdle();
    });

    it("(ttl3) row WITHOUT updatedAt (legacy pre-v9 write) → null → interrupted toast + row deleted, no crash", async () => {
      // UploadSessionRow types updatedAt as required, but rows written before
      // schema v9 can lack it at runtime — simulate one by omitting the field.
      const legacyRow = {
        id: "pending-old-ttl3",
        userEmail: USER,
        name: "legacy.mp3",
        isFolder: false,
        kind: "diskFile",
        diskPath: "C:/legacy.mp3",
        parentId: "root",
        totalSize: 2,
        uploadUri: OLD_URI,
        status: "active",
        createdAt: 1,
      } as unknown as UploadSessionRow;
      await db.uploadSessions.put(legacyRow);

      await um.resumeInterruptedUploads(TOKEN, USER);
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).toHaveBeenCalledWith("upload.interrupted");
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(ttl4) diskFile row updatedAt = now - (7 days + 1 min) → just over the TTL → expired → null → interrupted", async () => {
      await insertSessionRow({
        id: "pending-old-ttl4",
        name: "old2.mp3",
        kind: "diskFile",
        diskPath: "C:/old2.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
        updatedAt: Date.now() - (UPLOAD_SESSION_TTL_MS + 60 * 1000),
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await waitIdle();

      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).toHaveBeenCalledWith("upload.interrupted");
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(b1a) persist của entry mới fail giữa resume → row cũ còn nguyên status 'interrupted' + card cũ chưa xoá, lần resume sau phục hồi đúng session", async () => {
      // Crash simulation: every FRESH write is rejected (enqueue bulkPut +
      // processEntry put + session persist) and the pump hangs on a never-
      // resolving upload — exactly the dead-process moment between the resume
      // scan and the successor's own persisted rows. The OLD session row must
      // survive this moment marked 'interrupted' (deleting it beforehand loses
      // card + position forever), ready for the next launch's scan.
      const gate = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValue(gate.promise);
      const freshDb = await import("../db/db");
      const putSpy = vi
        .spyOn(freshDb.db.files, "put")
        .mockRejectedValue(new Error("db closed"));
      const bulkPutSpy = vi
        .spyOn(freshDb.db.files, "bulkPut")
        .mockRejectedValue(new Error("db closed"));
      const sessionPutSpy = vi
        .spyOn(freshDb.db.uploadSessions, "put")
        .mockRejectedValue(new Error("db closed"));
      await insertSessionRow({
        id: "pending-old-b1a",
        name: "crash.mp3",
        kind: "diskFile",
        diskPath: "C:/crash.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
        clientGeneratedId: "gen-b1a",
      });
      // The dimmed card the dead process left behind (id === old session id).
      await db.files.bulkPut([
        {
          id: "pending-old-b1a",
          name: "crash.mp3",
          mimeType: AUDIO_MIME,
          parentId: "root",
          trashed: false,
          isFolder: false,
          modifiedTime: "2026-01-01T00:00:00Z",
          userEmail: USER,
        },
      ]);

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      putSpy.mockRestore();
      bulkPutSpy.mockRestore();
      sessionPutSpy.mockRestore();

      // THE contract: the source row survived the dead-persist moment.
      const survivors = await db.uploadSessions.toArray();
      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.status).toBe("interrupted");
      expect(survivors[0]?.uploadUri).toBe(OLD_URI);
      // The old dimmed card must not have been swept either.
      const cards = await db.files.toArray();
      expect(cards).toHaveLength(1);
      expect(cards[0]?.id).toBe("pending-old-b1a");

      // Next launch: the scan picks the interrupted row back up and finishes
      // the upload with the SAME server session (URI + position preserved).
      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();
      const recoveryCalls = uploadFileResumableChunked.mock.calls;
      const opts = recoveryCalls[recoveryCalls.length - 1]?.[1];
      expect(opts?.initialUploadUri).toBe(OLD_URI);

      gate.resolve(makeDriveFile("f-recovered", "crash.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(b1c) row session mới của resumed entry kế thừa ngay uploadUri (+totalSize/clientGeneratedId) tại persist đầu", async () => {
      // Freeze the pipeline right AFTER processEntry's first persist (hanging
      // stat) — the exact crash window this contract covers. The NEW active
      // row must already carry the inherited server session URI, otherwise a
      // crash here restarts from byte 0 despite the server still holding the
      // resumable session (7-day TTL).
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);
      const statGate =
        deferred<NonNullable<Awaited<ReturnType<typeof statDiskPathImpl>>>>();
      statDiskPath.mockReturnValueOnce(statGate.promise);
      await insertSessionRow({
        id: "pending-old-b1c",
        name: "uri.mp3",
        kind: "diskFile",
        diskPath: "C:/uri.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
        clientGeneratedId: "gen-b1c",
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      const rows = await db.uploadSessions.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).not.toBe("pending-old-b1c"); // fresh successor row
      expect(rows[0]?.status).toBe("active");
      expect(rows[0]?.uploadUri).toBe(OLD_URI);
      expect(rows[0]?.totalSize).toBe(2);
      expect(rows[0]?.clientGeneratedId).toBe("gen-b1c");

      // Unfreeze: the resumed upload runs to completion and clears its row.
      statGate.resolve({
        path: "x",
        name: "x",
        relativePath: "x",
        isDirectory: false,
        size: 2,
      });
      d.resolve(makeDriveFile("f-uri", "uri.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(sweep) ghost pending rows swept at resume: orphan deleted, live-session row replaced by the fresh resumed card", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);
      await insertSessionRow({
        id: "pending-live-1",
        name: "a.mp3",
        kind: "diskFile",
        diskPath: "C:/a.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
      });
      // Two pending db.files rows: the live session's card (id === session id)
      // and an ORPHAN with no uploadSessions row anywhere — the app died
      // between the enqueue-time bulkPut and persistActiveSession. The orphan
      // is a permanent dimmed card unless the resume sweep removes it.
      await db.files.bulkPut([
        {
          id: "pending-live-1",
          name: "a.mp3",
          mimeType: AUDIO_MIME,
          parentId: "root",
          trashed: false,
          isFolder: false,
          modifiedTime: "2026-01-01T00:00:00Z",
          userEmail: USER,
        },
        {
          id: "pending-orphan-1",
          name: "ghost.mp3",
          mimeType: AUDIO_MIME,
          parentId: "root",
          trashed: false,
          isFolder: false,
          modifiedTime: "2026-01-01T00:00:00Z",
          userEmail: USER,
        },
      ]);

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      const ids = (await db.files.toArray()).map((r) => r.id);
      expect(ids).not.toContain("pending-orphan-1");
      // The live entry keeps its dimmed card: its old-id row is stale once the
      // session was consumed (the resumed entry carries a FRESH id), so the
      // sweep may drop it as long as the replacement card is present.
      const rows = await db.files.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("a.mp3");
      expect(rows[0]?.id).toMatch(/^pending-/);

      d.resolve(makeDriveFile("f1", "a.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(F2-r1) resume lần 2 khi predecessor lần 1 còn bị claim (successor chưa settle) → không nhân bản", async () => {
      const gate = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValue(gate.promise);
      // Block the round-1 successor's own session persist — exactly the crash
      // window P2-B1a covers: the source row stays 'interrupted' and the map
      // keeps claiming it while the successor is still uploading in-process.
      const freshDb = await import("../db/db");
      const sessionPutSpy = vi
        .spyOn(freshDb.db.uploadSessions, "put")
        .mockRejectedValue(new Error("db closed"));
      await insertSessionRow({
        id: "pending-old-f2r1",
        name: "twin.mp3",
        kind: "diskFile",
        diskPath: "C:/twin.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();
      expect(um.getEntries()).toHaveLength(1);
      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      const survivors = await db.uploadSessions.toArray();
      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.status).toBe("interrupted"); // claim alive (settle kept it)

      sessionPutSpy.mockRestore();

      // Round 2 while round-1's successor is still uploading: the claimed row
      // must be SKIPPED, never rebuilt into a clone.
      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      expect(um.getEntries()).toHaveLength(1);
      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      const sessions = await db.uploadSessions.toArray();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("pending-old-f2r1");
      expect(sessions[0]?.status).toBe("interrupted"); // không mark lại, không xoá

      gate.resolve(makeDriveFile("f-twin", "twin.mp3"));
      await waitIdle();
      // Successor's terminal net retires the claimed predecessor.
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(F2-r2) resume khi entry đang bay có row 'active' riêng (id trùng entry) → bỏ qua, row giữ nguyên", async () => {
      const gate = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        opts.onSessionUpdate?.(OLD_URI);
        return gate.promise;
      });

      um.startUploads([diskFileSeed("live.mp3", "C:/live.mp3")], TOKEN);
      await flush();
      const live = um.getEntries()[0];
      if (!live) throw new Error("expected live entry");
      expect(live.status).toBe("uploading");

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      expect(um.getEntries()).toHaveLength(1);
      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      const liveRow = (await db.uploadSessions.toArray()).find(
        (r) => r.id === live.id,
      );
      expect(liveRow?.status).toBe("active");
      expect((await db.files.toArray()).some((r) => r.id === live.id)).toBe(
        true,
      );

      gate.resolve(makeDriveFile("f-live", "live.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(F2-r3) guard giữ suốt vòng đời: gọi chồng giữa vòng 1 no-op sớm; kế nhiệm còn sống → lời gọi sau cũng không nhân bản", async () => {
      const freshDb = await import("../db/db");
      const realUpdate = freshDb.db.uploadSessions.update.bind(
        freshDb.db.uploadSessions,
      );
      let releaseScan!: () => void;
      const scanGate = new Promise<boolean>((resolve) => {
        releaseScan = () => {
          resolve(true);
        };
      });
      const updateSpy = vi
        .spyOn(freshDb.db.uploadSessions, "update")
        .mockImplementation(
          (key, changes) =>
            scanGate.then(() =>
              realUpdate(key, changes),
            ) as unknown as ReturnType<typeof realUpdate>,
        );
      const gate = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValue(gate.promise);
      await insertSessionRow({
        id: "pending-old-f2r3",
        name: "guard.mp3",
        kind: "diskFile",
        diskPath: "C:/guard.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
      });

      const p1 = um.resumeInterruptedUploads(TOKEN, USER);
      await realTick(6); // p1 now parked inside the gated mark-interrupted write
      expect(uploadFileResumableChunked).not.toHaveBeenCalled();

      const p2 = um.resumeInterruptedUploads(TOKEN, USER);
      await realTick(4);
      expect(uploadFileResumableChunked).not.toHaveBeenCalled(); // overlap → early no-op

      releaseScan();
      await Promise.all([p1, p2]);
      await flush();
      updateSpy.mockRestore();
      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      expect(um.getEntries()).toHaveLength(1);

      // Successor still alive (hung on gate) → a third call must also no-op.
      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();
      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      expect(um.getEntries()).toHaveLength(1);

      gate.resolve(makeDriveFile("f-guard", "guard.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(F3) folderChildFile crash SAU khi resolve parent (W2 persist: parentId thật + totalSize, chưa có URI) → resume như diskFile (fresh initiate đúng parent), KHÔNG bị refuse", async () => {
      // Crash window F3: handleChildFile đã resolve parent và
      // uploadDiskFileStreaming đã persist W2 (parentId thật + totalSize),
      // nhưng chunked uploader CHƯA kịp báo session URI → row không có
      // uploadUri. Row này tương đương diskFile cùng cửa sổ: diskPath có thật,
      // parent đã là Drive folder thật → phải được resume (không URI = fresh
      // initiate vào ĐÚNG parent đã persist), không bị xoá + toast interrupted.
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);
      await insertSessionRow({
        id: "pending-old-f3",
        name: "child3.flac",
        kind: "folderChildFile",
        diskPath: "C:/fold/child3.flac",
        parentId: "drive-folder-9", // real Drive id — do W2 persist sau khi resolve
        totalSize: 2, // dấu vết W2 (stat đã chạy SAU khi resolve parent)
        // không uploadUri — session chưa initiate
      });

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      // Được resume: chunked uploader chạy đúng 1 lần cho entry này.
      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      const opts = uploadFileResumableChunked.mock.calls[0]?.[1];
      // Upload vào ĐÚNG parent đã resolve (không phải placeholder).
      expect(opts?.parentId).toBe("drive-folder-9");
      // Không URI = fresh initiate (semantics giống diskFile cùng cửa sổ).
      expect(opts?.initialUploadUri).toBeUndefined();
      // Không bị đếm là interrupted.
      expect(showErrorToast).not.toHaveBeenCalled();
      // Row cũ đã settle (successor có row riêng, kế thừa parent thật).
      const rows = await db.uploadSessions.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).not.toBe("pending-old-f3");
      expect(rows[0]?.kind).toBe("folderChildFile");
      expect(rows[0]?.parentId).toBe("drive-folder-9");
      expect(rows[0]?.uploadUri).toBeUndefined();

      d.resolve(makeDriveFile("f-f3", "child3.flac"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(F4) crash: 1 entry đang bay + 1 card chưa kịp start (không có session row) → card bị sweep NHƯNG phải được đếm vào toast interrupted", async () => {
      // Crash scenario F4: lúc app chết, entry flying.mp3 đang bay (có session
      // row resumable), queued.mp3 mới được enqueue (card đã publish qua
      // enqueue-time bulkPut) nhưng CHƯA kịp start nên không có uploadSessions
      // row. Ghost sweep phải VẪN XOÁ card chưa-start này (giữ nguyên hành vi
      // xoá — tránh hồi sinh ghost), nhưng sự mất mát đó phải được ĐẾM vào
      // aggregated toast interrupted — code cũ để item biến mất im lặng.
      const d = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValueOnce(d.promise);
      // Entry đang bay lúc crash: row resumable (URI + totalSize).
      await insertSessionRow({
        id: "pending-old-f4",
        name: "flying.mp3",
        kind: "diskFile",
        diskPath: "C:/flying.mp3",
        totalSize: 2,
        uploadUri: OLD_URI,
      });
      // Card của seed CHƯA kịp start: chỉ có pending files-row, KHÔNG có
      // uploadSessions row ở bất kỳ đâu.
      await db.files.bulkPut([
        {
          id: "pending-unstarted-f4",
          name: "queued.mp3",
          mimeType: AUDIO_MIME,
          parentId: "root",
          trashed: false,
          isFolder: false,
          modifiedTime: "2026-01-01T00:00:00Z",
          userEmail: USER,
        },
      ]);

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      // Hành vi xoá GIỮ NGUYÊN: card chưa-start vẫn bị sweep.
      const cardIds = (await db.files.toArray()).map((r) => r.id);
      expect(cardIds).not.toContain("pending-unstarted-f4");
      // Contract F4: mất mát này phải được báo qua aggregated toast interrupted
      // (trước đây: im lặng vì interruptedCount không đếm card chưa-start).
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).toHaveBeenCalledWith("upload.interrupted");
      // Entry đang bay vẫn resume bình thường.
      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);

      d.resolve(makeDriveFile("f-f4", "flying.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });

    it("(F1) ghost sweep giữ card của entry đang sống chưa kịp persist session row, vẫn xoá orphan không chủ", async () => {
      // Race F1: card của seed mới (queued khi 2 slot concurrency đã đầy) tồn
      // tại trong db.files nhưng CHƯA có uploadSessions row (processEntry chưa
      // chạy tới nó). Snapshot keep-set của sweep không chứa id này → code cũ
      // bulkDelete nhầm card của entry đang sống. Orphan THẬT (không có chủ ở
      // đâu cả) vẫn phải bị xoá — nhiệm vụ gốc của sweep giữ nguyên.
      const da = deferred<DriveFileItem>();
      const dbB = deferred<DriveFileItem>();
      uploadFileResumable
        .mockReturnValueOnce(da.promise)
        .mockReturnValueOnce(dbB.promise);

      // Lấp đầy 2 slot: a + b uploading (đã persist session rows).
      um.startUploads([fileSeed("a.mp3"), fileSeed("b.mp3")], TOKEN);
      await flush();
      expect(await db.uploadSessions.toArray()).toHaveLength(2);

      // Seed mới → queued (hết slot): card đã publish qua enqueue-time
      // bulkPut, nhưng session row CHƯA tồn tại cho đến khi pump tới nó.
      um.startUploads([fileSeed("c-live.mp3")], TOKEN);
      await flush();
      const cEntry = um.getEntries().find((e) => e.name === "c-live.mp3");
      if (!cEntry) throw new Error("expected queued entry c-live.mp3");
      expect(cEntry.status).toBe("queued");
      expect((await db.files.toArray()).some((r) => r.id === cEntry.id)).toBe(
        true,
      );
      expect(await db.uploadSessions.toArray()).toHaveLength(2); // c chưa có row

      // Orphan thật: app chết giữa enqueue bulkPut và persistActiveSession.
      await db.files.bulkPut([
        {
          id: "pending-orphan-f1",
          name: "ghost.mp3",
          mimeType: AUDIO_MIME,
          parentId: "root",
          trashed: false,
          isFolder: false,
          modifiedTime: "2026-01-01T00:00:00Z",
          userEmail: USER,
        },
      ]);

      await um.resumeInterruptedUploads(TOKEN, USER);
      await flush();

      const idsAfter = (await db.files.toArray()).map((r) => r.id);
      // Contract F1: card của entry đang sống KHÔNG bị xoá dù chưa có session row.
      expect(idsAfter).toContain(cEntry.id);
      // Sweep vẫn làm đúng nhiệm vụ gốc: orphan bị xoá.
      expect(idsAfter).not.toContain("pending-orphan-f1");

      da.resolve(makeDriveFile("f-a", "a.mp3"));
      dbB.resolve(makeDriveFile("f-b", "b.mp3"));
      await waitIdle();
      expect(await db.uploadSessions.toArray()).toHaveLength(0);
    });
  });

  describe("duplicate seed guard (P2-B4)", () => {
    it("(d1) seed trùng diskPath+parentId khi entry còn active → bỏ qua, chỉ 1 entry + warn log không chứa path", async () => {
      const gate = deferred<DriveFileItem>();
      uploadFileResumableChunked.mockReturnValue(gate.promise);

      um.startUploads([diskFileSeed("x.mp3", "C:/Music/x.mp3")], TOKEN);
      await flush();
      expect(um.getEntries()).toHaveLength(1);
      expect(um.getEntries()[0]?.status).toBe("uploading");

      // Double-click / drop lần 2 cùng diskPath+parentId.
      um.startUploads([diskFileSeed("x.mp3", "C:/Music/x.mp3")], TOKEN);
      await flush();

      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(1);
      expect(um.getEntries()).toHaveLength(1);
      expect(await db.files.toArray()).toHaveLength(1); // chỉ 1 pending row
      const dupLog = captureError.mock.calls.find((c) =>
        c[0].message.includes("duplicate-seed-skipped"),
      );
      expect(dupLog?.[0].level).toBe("warn");
      // Log không được chứa đường dẫn người dùng — chỉ basename.
      expect(dupLog?.[0].message).not.toContain("C:/Music");
      expect(dupLog?.[0].message).toContain("name=x.mp3");

      gate.resolve(makeDriveFile("f-dup", "x.mp3"));
      await waitIdle();
    });

    it("(d2) seed trùng nhưng entry đầu đã error (đã prune) → vẫn tạo entry mới (retry chủ ý)", async () => {
      uploadFileResumableChunked
        .mockRejectedValueOnce(new UploadErrorClass("boom", "network"))
        .mockResolvedValueOnce(makeDriveFile("f-retry", "x.mp3"));

      um.startUploads([diskFileSeed("x.mp3", "C:/x.mp3")], TOKEN);
      await waitIdle();
      expect(um.getEntries()).toEqual([]); // entry lỗi đã prune

      um.startUploads([diskFileSeed("x.mp3", "C:/x.mp3")], TOKEN);
      await waitIdle();

      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(2);
      const rows = await db.files.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("f-retry");
    });

    it("(d3) cùng diskPath khác parentId → KHÔNG bị chặn (key gồm cả parentId)", async () => {
      uploadFileResumableChunked
        .mockResolvedValueOnce(makeDriveFile("f-a", "x.mp3"))
        .mockResolvedValueOnce(makeDriveFile("f-b", "x.mp3"));

      um.startUploads(
        [
          {
            name: "x.mp3",
            isFolder: false,
            parentId: "root",
            diskPath: "C:/x.mp3",
          },
          {
            name: "x.mp3",
            isFolder: false,
            parentId: "folder-other",
            diskPath: "C:/x.mp3",
          },
        ],
        TOKEN,
      );
      await waitIdle();

      expect(uploadFileResumableChunked).toHaveBeenCalledTimes(2);
      const rows = await db.files.toArray();
      expect(rows.map((r) => r.id).sort()).toEqual(["f-a", "f-b"]);
    });
  });
});
