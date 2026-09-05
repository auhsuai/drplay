// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { db } from "../../db/db";
import type { getDriveStorageQuota as getDriveStorageQuotaImpl } from "../driveApi";
import type {
  generateClientId as generateClientIdImpl,
  uploadFileResumable as uploadFileResumableImpl,
} from "../driveUpload";
import type { showErrorToast as showErrorToastImpl } from "../simpleToast";

// Finding B lock: pump() floats as `void pump()` (pump.ts + resume.ts), which
// is only safe while processEntry provably never rejects. This file pins that
// invariant: a persistently failing entry must still settle terminally with
// the floating pump resolved — never an unhandled rejection or an entry stuck
// in 'uploading'. Mocks + flush helpers mirror uploadManager.test.ts.
vi.mock("../driveApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../driveApi")>();
  return {
    ...actual,
    getDriveStorageQuota: vi.fn(),
  };
});

vi.mock("../driveUpload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../driveUpload")>();
  return {
    ...actual, // keep the REAL UploadError class — `instanceof` must work
    generateClientId: vi.fn(),
    uploadFileResumable: vi.fn(),
    uploadFileResumableChunked: vi.fn(),
  };
});

vi.mock("../errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("../simpleToast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

vi.mock("i18next", () => ({
  t: (key: string) => key,
}));

// Re-imported per test after vi.resetModules() so the queue's module-level
// state (entries, busy flag) starts clean.
let pumpMod: typeof import("./pump");
let eventsMod: typeof import("./events");
let terminalMod: typeof import("./terminal");
let uploadFileResumable: Mock<typeof uploadFileResumableImpl>;
let generateClientId: Mock<typeof generateClientIdImpl>;
let getDriveStorageQuota: Mock<typeof getDriveStorageQuotaImpl>;
let showErrorToast: Mock<typeof showErrorToastImpl>;
let UploadErrorClass: typeof import("../driveUpload").UploadError;

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.resetModules();
  pumpMod = await import("./pump");
  eventsMod = await import("./events");
  terminalMod = await import("./terminal");
  const du = await import("../driveUpload");
  const da = await import("../driveApi");
  const st = await import("../simpleToast");
  uploadFileResumable = vi.mocked(du.uploadFileResumable);
  generateClientId = vi.mocked(du.generateClientId);
  getDriveStorageQuota = vi.mocked(da.getDriveStorageQuota);
  showErrorToast = vi.mocked(st.showErrorToast);
  UploadErrorClass = du.UploadError;

  getDriveStorageQuota.mockResolvedValue({
    limit: null,
    usage: 0,
    usageInDrive: 0,
    usageInDriveTrash: 0,
  });
  generateClientId.mockResolvedValue("cid-test");

  await db.files.clear();
  await db.uploadSessions.clear();
});

// fake-indexeddb schedules IDB work via setImmediate (jsdom has none), so a
// pure-microtask flush would miss it — yield the real event loop instead.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
  }
}

async function waitIdle(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (terminalMod.getUploadingIds().size > 0) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for upload queue to idle");
    }
    await new Promise<void>((r) => {
      setTimeout(r, 5);
    });
  }
  await flush();
}

describe("upload pump never-reject invariant (Finding B)", () => {
  it("floating startUploads settles a persistently failing entry as terminal error without rejecting", async () => {
    // Non-retryable failure (kind invalid skips the backoff sleep entirely),
    // so the test stays fast on real timers.
    uploadFileResumable.mockRejectedValue(
      new UploadErrorClass("boom", "invalid"),
    );
    const snapshots: Array<
      Array<{ status: string; error?: string | undefined }>
    > = [];
    eventsMod.subscribe(() => {
      snapshots.push(
        eventsMod
          .getEntries()
          .map((e) => ({ status: e.status, error: e.error })),
      );
    });

    // Fire-and-forget exactly like production: startUploads floats pump()
    // internally, so any processEntry rejection would surface here as an
    // unhandled rejection and fail this run (vitest default).
    pumpMod.startUploads(
      [
        {
          name: "a.mp3",
          isFolder: false,
          parentId: "root",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
      "test-token",
    );
    await waitIdle();

    expect(uploadFileResumable).toHaveBeenCalled();
    // The entry reached terminal 'error' (not stuck in 'uploading') and
    // markError ran to completion (toast sent, entry pruned after notify).
    expect(snapshots.some((s) => s.some((e) => e.status === "error"))).toBe(
      true,
    );
    expect(showErrorToast).toHaveBeenCalled();
    expect(eventsMod.getEntries()).toHaveLength(0);
    await expect(pumpMod.pump()).resolves.toBeUndefined();
  });
});
