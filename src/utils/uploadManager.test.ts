// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { db } from "../db/db";
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
    ...actual, // keep the REAL UploadError class â€” `instanceof` must work
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

vi.mock("../utils/errorLog", () => ({
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
  // mocked module), so the same vi.fn() instances persist â€” clear their call
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
// fake-indexeddb lib/scheduling.js â€” jsdom does not provide it, so Node's real
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

// Fire only the faked timers (backoff sleep) â€” microtasks flush in between.
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
// INSIDE notify() â€” before the prune â€” so snapshotting there still observes
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
  it("1. queue tuáº§n tá»±: upload tiáº¿p theo chá»‰ báº¯t Ä‘áº§u sau khi cÃ¡i trÆ°á»›c xong", async () => {
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
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(uploadFileResumable.mock.calls[0]?.[2]).toBe("a.mp3");

    d1.resolve(makeDriveFile("f1", "a.mp3"));
    await flush();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);
    expect(uploadFileResumable.mock.calls[1]?.[2]).toBe("b.mp3");

    d2.resolve(makeDriveFile("f2", "b.mp3"));
    await flush();
    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
    d3.resolve(makeDriveFile("f3", "c.mp3"));
    await waitIdle();

    expect(maxActive).toBe(1);
    // Subscriber snapshot of the last notify still carries the final 'done'.
    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
    expect(um.getEntries()).toEqual([]);
  });

  it("2. happy path (bytes): pending row put khi uploading, row tháº­t vá»›i drive id khi done", async () => {
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

  it("3. UploadError invalid â†’ entry error + pending row deleted + captureError + khÃ´ng retry", async () => {
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

  it("4. quota exceeded â†’ error quota + toast + khÃ´ng gá»i upload", async () => {
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

  it("5. quota unlimited (limit=null) â†’ upload váº«n cháº¡y", async () => {
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("ok.mp3")], TOKEN);
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(1);
    expect(snapshots[snapshots.length - 1]?.map((s) => s.status)).toEqual([
      "done",
    ]);
  });

  it("6. quota fetch fail (reject hoáº·c null) â†’ khÃ´ng block, upload váº«n cháº¡y", async () => {
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

  it("7. retry: network fail láº§n 1 â†’ backoff 1â€“1.5s (exp+jitter) â†’ láº§n 2 pass â†’ done", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    uploadFileResumable
      .mockRejectedValueOnce(new UploadErrorClass("network hiccup", "network"))
      .mockResolvedValueOnce(makeDriveFile("file-7", "retry.mp3"));
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("retry.mp3")], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    await advanceBackoff(1500); // backoffDelay(attempt-1=0) âˆˆ [1000, 1500)
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    await realTick();
    expect(snapshots[snapshots.length - 1]).toEqual([
      { status: "done", error: undefined },
    ]);
    expect(um.getEntries()).toEqual([]);
  });

  it("8. retry háº¿t: network x3 â†’ error, Ä‘Ãºng 3 calls", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    uploadFileResumable.mockRejectedValue(
      new UploadErrorClass("network down", "network"),
    );
    const snapshots = captureSnapshots();

    um.startUploads([fileSeed("n.mp3")], TOKEN);
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(1);

    await advanceBackoff(1500); // backoffDelay(attempt-1=0) âˆˆ [1000, 1500)
    await realTick();
    expect(uploadFileResumable).toHaveBeenCalledTimes(2);

    await advanceBackoff(3000); // backoffDelay(attempt-1=1) âˆˆ [2000, 3000)
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

  it("9. kind aborted â†’ error ngay, 1 call duy nháº¥t", async () => {
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

    await advanceBackoff(1500); // backoffDelay(attempt-1=0) âˆˆ [1000, 1500)
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

  it("10. folder upload: createFolder chuá»—i + memoize subfolder + basename/parent Ä‘Ãºng", async () => {
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

  it("11. folder pending row â†’ row tháº­t (id = driveId) sau createFolder", async () => {
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
    // quota check chá»‰ cháº¡y trÆ°á»›c file upload, khÃ´ng pháº£i folder-create
    expect(getDriveStorageQuota).not.toHaveBeenCalled();
  });

  it("12. getUploadingIds: entry + parentId + driveId (folder), khÃ´ng bao giá» chá»©a root; sáº¡ch sau done", async () => {
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

  it("12b. folder Ä‘ang upload (Ä‘Ã£ cÃ³ driveId) â†’ driveId náº±m trong uploading ids qua parentId cá»§a con", async () => {
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

  it("13. subscribe/unsubscribe: cb gá»i Ä‘Ãºng sá»‘ láº§n; unsubscribe â†’ khÃ´ng gá»i ná»¯a", async () => {
    const cb = vi.fn();
    const unsub = um.subscribe(cb);

    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await waitIdle();

    // queued-push + uploading + done = 3 láº§n
    expect(cb).toHaveBeenCalledTimes(3);
    expect(firedEvents("upload-status-changed")).toHaveLength(3);

    unsub();
    um.startUploads([fileSeed("t.mp3")], TOKEN);
    await waitIdle();
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it("14. drive-files-changed fire sau má»—i done vá»›i detail.count=1", async () => {
    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await waitIdle();

    const fired = firedEvents("drive-files-changed");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.detail).toEqual({ count: 1 });
  });

  it("15. seed khÃ´ng há»£p lá»‡ â†’ error invalid-seed ngay, khÃ´ng gá»i API", async () => {
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

  it("16. startUploads khi queue Ä‘ang cháº¡y â†’ ná»‘i thÃªm, khÃ´ng Ä‘á»¥ng entry Ä‘ang upload", async () => {
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

  it("17. isUploading(id) theo Ä‘Ãºng getUploadingIds", async () => {
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

  it("file seed tá»« diskPath: register + stat + openDiskReadStream + chunked upload vá»›i basename", async () => {
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
    // Disk files stream via the chunked uploader â€” the whole-file bytes path
    // must NOT be used.
    expect(uploadFileResumable).not.toHaveBeenCalled();

    // The stream opened for the upload is closed on completion (finally).
    // (mock.results holds the raw Promise â€” await it to get the stream.)
    const firstResult = openDiskReadStream.mock.results[0];
    if (firstResult === undefined)
      throw new Error("expected stream open result");
    const stream = (await firstResult.value) as {
      close: ReturnType<typeof vi.fn>;
    };
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("openDiskReadStream fail â†’ entry error failed, khÃ´ng upload", async () => {
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

  it("statDiskPath null (file biáº¿n máº¥t giá»¯a chá»«ng) â†’ entry error failed, khÃ´ng upload", async () => {
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

  it("disk file: totalSize tá»« stat Ä‘Æ°á»£c dÃ¹ng cho quota check trÆ°á»›c khi má»Ÿ stream", async () => {
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

  it("chunked upload progress: onProgress ghi entry.progress + throttle 1 notify sau 500ms; done xÃ³a timer", async () => {
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
    // queued-push + uploading only â€” the progress update sits in the throttled
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

  it("chunked upload throw â†’ stream.close váº«n Ä‘Æ°á»£c gá»i (finally)", async () => {
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

  it("chunked 308-rewind: readChunk offset < vá»‹ trÃ­ stream â†’ reopen stream má»›i tá»« Ä‘áº§u", async () => {
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

  it("chunked 308 partial-ack giá»¯a chunk: skip overshoot â†’ tráº£ remainder báº¯t Ä‘áº§u ÄÃšNG offset (khÃ´ng lá»‡ch vá»‹ trÃ­)", async () => {
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

  it("file growth: totalSize tá»« stat.size, readChunk khÃ´ng truncate á»Ÿ táº§ng manager", async () => {
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
        .mockResolvedValueOnce(seq(64, 64)) // bytes 64..127 â€” stream outlives the announced size
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
    // readChunk stays a pure reader â€” overshoot handling lives in driveApi.
    expect(reads[0]).toEqual(seq(0, 64));
    expect(reads[1]).toEqual(seq(64, 64));
  });

  it("getUploadState: entry.id Ä‘ang upload/queued â†’ uploading", async () => {
    const d = deferred<DriveFileItem>();
    // NOTE: no second once-implementation â€” the queue is sequential, so b.mp3
    // never starts while a.mp3 is deferred; a leftover once-impl would leak
    // into the next test (vitest clearAllMocks does NOT clear once-queue).
    uploadFileResumable.mockReturnValueOnce(d.promise);

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

    d.resolve(makeDriveFile("f1", "a.mp3"));
    await waitIdle();
  });

  it("getUploadState: folder batch â€” con Ä‘ang upload (parentId=folder driveId) â†’ folder chá»‰ parent-uploading (háº¿t má»)", async () => {
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

    // folder root Ä‘Ã£ done (driveId='folder-1'); con Ä‘ang upload vá»›i parentId='folder-1'
    // â†’ folder chá»‰ 'parent-uploading' (háº¿t má», giá»¯ spinner) â€” ADR deviation Ä‘Ã£ chá»‘t.
    expect(um.getUploadState("folder-1")).toBe("parent-uploading");

    d.resolve(makeDriveFile("f-a", "a.mp3"));
    await waitIdle();
  });

  it("getUploadState: parentId â†’ parent-uploading; root khÃ´ng bao giá» parent-uploading", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3", "folder-9")], TOKEN);
    await flush();

    expect(um.getUploadState("folder-9")).toBe("parent-uploading");
    expect(um.getUploadState("root")).toBe("none");

    d.resolve(makeDriveFile("f9", "s.mp3"));
    await waitIdle();
  });

  it("getUploadState: sau done â†’ none", async () => {
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

  it("getUploadState: sau done â†’ uploaded (check xanh qua driveId); dismissUploaded â†’ none ngay; pending id Ä‘Ã£ prune â†’ none", async () => {
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await flush();
    const firstEntry = um.getEntries()[0];
    if (!firstEntry) throw new Error("expected upload entry");
    const entryId = firstEntry.id;

    d.resolve(makeDriveFile("f9", "s.mp3"));
    await waitIdle();

    // markRecentlyDone nháº­n driveId — cÃ¡i id live list biáº¿t item báº±ng — nÃªn
    // check hiá»ƒn cho driveId; pending id (entry Ä‘Ã£ bá»‹ prune) tráº£ vá» none.
    expect(um.getUploadState("f9")).toBe("uploaded");
    expect(um.getUploadState(entryId)).toBe("none");

    // Click play â†’ dismissUploaded â†’ row vá» idle MoreMenu ngay (khÃ´ng chá» 10s).
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

  it("uploaded tint tá»± háº¿t sau 10s qua timer; dismissUploaded id khÃ´ng náº±m trong set â†’ no-op khÃ´ng throw", async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
    const d = deferred<DriveFileItem>();
    uploadFileResumable.mockReturnValueOnce(d.promise);

    um.startUploads([fileSeed("s.mp3")], TOKEN);
    await realTick();
    d.resolve(makeDriveFile("f9", "s.mp3"));
    await realTick(12);

    expect(um.getUploadState("f9")).toBe("uploaded");

    // Chá»‰ cÃ²n Ä‘Ãºng 1 timer: tint 10s (auto-clears, khÃ´ng leak).
    expect(vi.getTimerCount()).toBe(1);
    await advanceBackoff(10_000);
    expect(um.getUploadState("f9")).toBe("none");
    expect(vi.getTimerCount()).toBe(0);

    expect(() => {
      um.dismissUploaded("f9");
    }).not.toThrow();
    expect(um.getUploadState("f9")).toBe("none");
  });

  it("createFolder subfolder fail â†’ subfolder error; file con trong Ä‘Ã³ â†’ parent-folder-missing", async () => {
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

  it("A. prune: 3 file bytes upload xong â†’ getEntries tráº£ [] (khÃ´ng giá»¯ entry terminal)", async () => {
    um.startUploads(
      [fileSeed("a.mp3"), fileSeed("b.mp3"), fileSeed("c.mp3")],
      TOKEN,
    );
    await waitIdle();

    expect(um.getEntries()).toEqual([]);
    expect(um.getUploadingIds().size).toBe(0);
  });

  it("B. prune: entry error (UploadError invalid) â†’ getEntries tráº£ []", async () => {
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

  it("B2. UploadError invalid â†’ log gá»“m name + kind + message UploadError (status 4xx)", async () => {
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

  it("B3. Plain Error tá»« diskFs (message chá»©a full disk path) â†’ log chá»‰ name+kind, khÃ´ng lá»™ path", async () => {
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

  it("C. prune: folder batch (folder + subfolder + 2 files con) xong â†’ getEntries tráº£ []", async () => {
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

  it("D. prune khÃ´ng phÃ¡ queue: startUploads batch 2 sau batch 1 xong â†’ cháº¡y bÃ¬nh thÆ°á»ng", async () => {
    um.startUploads([fileSeed("a.mp3")], TOKEN);
    await waitIdle();
    expect(um.getEntries()).toEqual([]);

    um.startUploads([fileSeed("b.mp3"), fileSeed("c.mp3")], TOKEN);
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalledTimes(3);
    expect(um.getUploadingIds().size).toBe(0);
    expect(um.getEntries()).toEqual([]);
  });

  it("E. prune: sau done, getUploadingIds/isUploading/getUploadState khÃ´ng cÃ²n dÃ­nh entry Ä‘Ã£ xong", async () => {
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
    it("1. cancel entry Ä‘ang upload (chunked) â†’ error aborted + khÃ´ng toast + xÃ³a pending row + prune", async () => {
      uploadFileResumableChunked.mockImplementation(async (_t, opts) => {
        // Real driveApi listens on the wired signal and rejects with
        // UploadError('aborted') â€” mirror that so the manager's markError
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

    it("2. cancel entry queued â†’ khÃ´ng gá»i upload API cho nÃ³, error aborted + prune ngay, queue khÃ´ng Ä‘á»¥ng", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumable.mockReturnValueOnce(d.promise);

      um.startUploads([fileSeed("a.mp3"), fileSeed("b.mp3")], TOKEN);
      await flush();

      expect(uploadFileResumable).toHaveBeenCalledTimes(1);
      const entries = um.getEntries();
      const a = entries[0];
      const b = entries[1];
      if (a === undefined || b === undefined)
        throw new Error("expected 2 upload entries");
      expect(b.status).toBe("queued");

      um.cancelUpload(b.id);
      expect(uploadFileResumable).toHaveBeenCalledTimes(1); // b chÆ°a bao giá» start
      expect(um.getEntries().map((e) => e.id)).toEqual([a.id]); // b bá»‹ prune ngay
      expect(showErrorToast).not.toHaveBeenCalled();

      d.resolve(makeDriveFile("f1", "a.mp3"));
      await waitIdle();
      expect(uploadFileResumable).toHaveBeenCalledTimes(1); // pump bá» qua b (Ä‘Ã£ error)
      expect(um.getEntries()).toEqual([]);
      expect(showErrorToast).not.toHaveBeenCalled();
    });

    it("3. cancel id khÃ´ng tá»“n táº¡i â†’ no-op khÃ´ng throw, entries khÃ´ng Ä‘á»•i", async () => {
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

    it("4. cancel 2 láº§n liÃªn tiáº¿p â†’ láº§n 2 no-op (abort idempotent), chá»‰ 1 láº§n xá»­ lÃ½ aborted", async () => {
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
      um.cancelUpload(id); // signal Ä‘Ã£ aborted â†’ abort() lÃ  no-op
      await waitIdle();

      expect(abortEvents).toBe(1);
      expect(um.getEntries()).toEqual([]);
      const cancelled = captureError.mock.calls.filter((c) =>
        c[0].message.includes("upload-cancelled"),
      );
      expect(cancelled).toHaveLength(1);
      expect(showErrorToast).not.toHaveBeenCalled();
    });

    it("5. cancel sau khi entry terminal (done) â†’ no-op khÃ´ng throw", async () => {
      um.startUploads([fileSeed("a.mp3")], TOKEN);
      await waitIdle();
      expect(um.getEntries()).toEqual([]);

      expect(() => {
        um.cancelUpload("pending-whatever");
      }).not.toThrow();
    });

    it("6. cancel folder root khi Ä‘ang walk â†’ aborted + khÃ´ng toast + khÃ´ng createFolder + khÃ´ng enqueue children", async () => {
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

    it("7. cancel folder root sau walk, trong lÃºc createFolder â†’ aborted + khÃ´ng enqueue children", async () => {
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

    it("8. cancel folder child (Ä‘ang createFolder subfolder) â†’ child aborted + khÃ´ng toast + file con khÃ´ng upload", async () => {
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
      // x.mp3's parent subfolder never materialized â†’ it must not upload.
      expect(uploadFileResumableChunked).not.toHaveBeenCalled();
      expect(um.getEntries()).toEqual([]);
    });

    it("11. cancel bytes-upload Ä‘ang retry giá»¯a backoff â†’ khÃ´ng retry tiáº¿p, error aborted", async () => {
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
      um.cancelUpload(id); // abort trong lÃºc backoff
      await advanceBackoff(1500); // backoffDelay(attempt-1=0) âˆˆ [1000, 1500)
      await realTick();

      expect(uploadFileResumable).toHaveBeenCalledTimes(1); // khÃ´ng retry sau abort
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
  });

  describe("getUploadProgress", () => {
    it("10. tráº£ progress fraction cá»§a entry uploading; undefined khi chÆ°a cÃ³ / id láº¡ / sau done", async () => {
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

    it("10b. bytes upload / entry queued (chÆ°a cÃ³ progress) â†’ undefined", async () => {
      const d = deferred<DriveFileItem>();
      uploadFileResumable.mockReturnValueOnce(d.promise);

      um.startUploads([fileSeed("a.mp3"), fileSeed("b.mp3")], TOKEN);
      await flush();

      const entries = um.getEntries();
      const a = entries[0];
      const b = entries[1];
      if (a === undefined || b === undefined)
        throw new Error("expected 2 upload entries");
      expect(um.getUploadProgress(a.id)).toBeUndefined(); // uploading nhÆ°ng chÆ°a cÃ³ progress
      expect(um.getUploadProgress(b.id)).toBeUndefined(); // queued

      d.resolve(makeDriveFile("f1", "a.mp3"));
      await waitIdle();
    });
  });

  describe("progress throttle", () => {
    it("6. onProgress 3 láº§n nhanh â†’ coalesce 1 notify sau 500ms; Ä‘á»£t 2 cÃ¡ch >500ms â†’ notify thá»© 2", async () => {
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
      expect(cb).toHaveBeenCalledTimes(2); // queued + uploading â€” burst Ä‘ang chá» timer
      await advanceBackoff(500);
      expect(cb).toHaveBeenCalledTimes(3); // 3 onProgress nhanh â†’ Ä‘Ãºng 1 notify

      onProgress?.(0.95); // Ä‘á»£t 2, cÃ¡ch > 500ms
      expect(cb).toHaveBeenCalledTimes(3);
      await advanceBackoff(500);
      expect(cb).toHaveBeenCalledTimes(4); // notify thá»© 2

      d.resolve(makeDriveFile("f1", "x.mp3"));
      await realTick(12);
      expect(cb).toHaveBeenCalledTimes(5); // done notify NGAY, khÃ´ng bá»‹ delay bá»Ÿi throttle
      expect(vi.getTimerCount()).toBe(1); // +1 tint timer (10s, auto-clears)
    });

    it("7. progress khÃ´ng Ä‘á»•i â†’ khÃ´ng notify thá»«a (1 notify duy nháº¥t cho cÃ¹ng giÃ¡ trá»‹)", async () => {
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
      expect(cb).toHaveBeenCalledTimes(3); // 2 baseline + Ä‘Ãºng 1 notify (coalesce cÃ¹ng giÃ¡ trá»‹)

      onProgress?.(0.5); // cÃ¹ng giÃ¡ trá»‹ láº·p láº¡i
      await advanceBackoff(500);
      expect(cb).toHaveBeenCalledTimes(3); // khÃ´ng notify thÃªm

      d.resolve(makeDriveFile("f1", "x.mp3"));
      await realTick(12);
      expect(cb).toHaveBeenCalledTimes(4); // done notify
      expect(vi.getTimerCount()).toBe(1); // +1 tint timer (10s, auto-clears)
    });

    it("9. timer dá»n khi entry done â€” khÃ´ng cÃ²n pending timer (trÃ¡nh leak)", async () => {
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
      const d = deferred<DriveFileItem>();
      uploadFileResumable.mockReturnValueOnce(d.promise);

      um.startUploads([fileSeed("a.mp3"), fileSeed("b.mp3")], TOKEN);
      await flush();

      const b = um.getEntries().find((e) => e.name === "b.mp3");
      if (!b) throw new Error("expected queued entry");
      expect(b.status).toBe("queued");
      // The active upload owns a row; the queued entry never persisted one.
      expect(await db.uploadSessions.toArray()).toHaveLength(1);

      expect(() => {
        um.cancelUpload(b.id);
      }).not.toThrow();
      expect(
        await db.uploadSessions.where("id").equals(b.id).toArray(),
      ).toHaveLength(0);

      d.resolve(makeDriveFile("f1", "a.mp3"));
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
        updatedAt: 1,
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
  });
});
