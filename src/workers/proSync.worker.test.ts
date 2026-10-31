import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, type DriveFile } from "../db/db";
import {
  delay,
  fetchDrive,
  handleWorkerMessage,
  isTransientStatus,
  isWorkerRequestMessage,
  isValidDriveFile,
  partitionValidFiles,
  refreshTokenAndRetry,
} from "./proSync.worker";
import type { SyncRetryState } from "./proSync.worker";
import { syncRetryDeps } from "./tokenRefresh";
import { syncRetry } from "./syncState";
import { performDeltaSync } from "./deltaSync";
import { performFullSync } from "./fullSync";
import { DEFAULT_USER_EMAIL } from "../utils/storageKeys";

vi.mock("../utils/errorLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/errorLog")>()),
  captureError: vi.fn().mockResolvedValue(undefined),
}));

import { captureError } from "../utils/errorLog";

// Wire owner used by every pre-existing sync fixture: schema v10 requires a
// REAL account email on the frame and on every persisted row ("default" is
// now a rejected sentinel), so fixtures state their expected owner explicitly.
const FIXTURE_EMAIL = "sync-owner@example.com";

describe("isValidDriveFile", () => {
  it("returns true for a file with a non-empty string id", () => {
    expect(
      isValidDriveFile({
        id: "abc123",
        name: "song.mp3",
        mimeType: "audio/mpeg",
      }),
    ).toBe(true);
  });

  it("returns false for an empty string id", () => {
    expect(
      isValidDriveFile({ id: "", name: "song.mp3", mimeType: "audio/mpeg" }),
    ).toBe(false);
  });

  it("returns false when id is undefined", () => {
    expect(isValidDriveFile({ name: "song.mp3", mimeType: "audio/mpeg" })).toBe(
      false,
    );
    expect(
      isValidDriveFile({
        id: undefined,
        name: "song.mp3",
        mimeType: "audio/mpeg",
      }),
    ).toBe(false);
  });

  it("returns false for a non-string id (runtime guard)", () => {
    const f = {
      id: 42,
      name: "song.mp3",
      mimeType: "audio/mpeg",
    } as unknown as Parameters<typeof isValidDriveFile>[0];
    expect(isValidDriveFile(f)).toBe(false);
  });
});

describe("partitionValidFiles", () => {
  it("returns every file and skippedCount 0 when all files have an id", () => {
    const files = [
      { id: "a", name: "a.mp3", mimeType: "audio/mpeg" },
      { id: "b", name: "b.mp3", mimeType: "audio/mpeg" },
    ];
    const { valid, skippedCount } = partitionValidFiles(files);
    expect(skippedCount).toBe(0);
    expect(valid).toHaveLength(2);
    expect(valid.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("keeps valid files and counts files missing an id", () => {
    const files = [
      { id: "a", name: "a.mp3", mimeType: "audio/mpeg" },
      { name: "no-id.mp3", mimeType: "audio/mpeg" },
      { id: "", name: "empty-id.mp3", mimeType: "audio/mpeg" },
      { id: "b", name: "b.mp3", mimeType: "audio/mpeg" },
    ];
    const { valid, skippedCount } = partitionValidFiles(files);
    expect(skippedCount).toBe(2);
    expect(valid).toHaveLength(2);
    expect(valid.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("returns an empty valid list and skippedCount equal to the input size when no file has an id", () => {
    const files = [
      { name: "no-id-1.mp3", mimeType: "audio/mpeg" },
      { name: "no-id-2.mp3", mimeType: "audio/mpeg" },
      { id: "", name: "empty-id.mp3", mimeType: "audio/mpeg" },
    ];
    const { valid, skippedCount } = partitionValidFiles(files);
    expect(skippedCount).toBe(3);
    expect(valid).toEqual([]);
  });

  it("handles an empty input without side effects", () => {
    const { valid, skippedCount } = partitionValidFiles([]);
    expect(skippedCount).toBe(0);
    expect(valid).toEqual([]);
  });
});

describe("refreshTokenAndRetry", () => {
  function makeState(count: number, max: number): SyncRetryState {
    return { count, max };
  }

  function makeDeps(waitResult: boolean) {
    const sent: Array<{ type: string }> = [];
    let waitCalls = 0;
    const deps = {
      postMessage: (msg: { type: string }) => {
        sent.push(msg);
      },
      waitForTokenRefresh: () => {
        waitCalls++;
        return Promise.resolve(waitResult);
      },
    };
    return { deps, sent, waitCalls: () => waitCalls };
  }

  it("gives up when count is already at max: returns false, posts NOTHING (caller owns the terminal signal), no wait", async () => {
    const state = makeState(3, 3);
    const { deps, sent, waitCalls } = makeDeps(true);

    const result = await refreshTokenAndRetry(
      state,
      deps,
      "full-sync/startPageToken",
    );

    expect(result).toBe(false);
    // B18-4: the shared 401 helper must never post a terminal signal — the
    // caller decides (posting here double-signaled budget-exhausted failures).
    expect(sent).toEqual([]);
    expect(waitCalls()).toBe(0);
    expect(state.count).toBe(3);
  });

  it("still has retries: posts TOKEN_EXPIRED and waits for a token refresh", async () => {
    const state = makeState(0, 3);
    const { deps, sent, waitCalls } = makeDeps(true);

    const result = await refreshTokenAndRetry(state, deps, "full-sync/files");

    expect(sent).toEqual([{ type: "TOKEN_EXPIRED" }]);
    expect(waitCalls()).toBe(1);
    expect(result).toBe(true);
  });

  it("on successful refresh: resets the retry count to 0 and returns true", async () => {
    const state = makeState(1, 3);
    const { deps, sent, waitCalls } = makeDeps(true);

    const result = await refreshTokenAndRetry(
      state,
      deps,
      "delta-sync/changes",
    );

    expect(result).toBe(true);
    expect(waitCalls()).toBe(1);
    expect(state.count).toBe(0);
    expect(sent).toEqual([{ type: "TOKEN_EXPIRED" }]);
  });

  it("on failed refresh: returns false without resetting the count", async () => {
    const state = makeState(2, 3);
    const { deps, sent, waitCalls } = makeDeps(false);

    const result = await refreshTokenAndRetry(
      state,
      deps,
      "delta-sync/changes",
    );

    expect(result).toBe(false);
    expect(waitCalls()).toBe(1);
    expect(state.count).toBe(3);
    expect(sent).toEqual([{ type: "TOKEN_EXPIRED" }]);
  });

  it("does not post SYNC_ERROR on the retry path even when refresh fails", async () => {
    const state = makeState(0, 3);
    const { deps, sent } = makeDeps(false);

    const result = await refreshTokenAndRetry(state, deps, "full-sync/files");

    expect(result).toBe(false);
    expect(sent).toEqual([{ type: "TOKEN_EXPIRED" }]);
  });
});

describe("isWorkerRequestMessage", () => {
  it("accepts a valid sync message", () => {
    expect(isWorkerRequestMessage({ type: "sync", token: "x" })).toBe(true);
  });

  it("accepts a valid token message", () => {
    expect(isWorkerRequestMessage({ type: "token", token: "x" })).toBe(true);
  });

  it("rejects a message without a token", () => {
    expect(isWorkerRequestMessage({ type: "sync" })).toBe(false);
    expect(isWorkerRequestMessage({ type: "token" })).toBe(false);
  });

  it("rejects a token with the wrong type", () => {
    expect(isWorkerRequestMessage({ type: "sync", token: 42 })).toBe(false);
  });

  it("rejects an unknown message type", () => {
    expect(isWorkerRequestMessage({ type: "garbage", token: "x" })).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isWorkerRequestMessage(null)).toBe(false);
    expect(isWorkerRequestMessage(undefined)).toBe(false);
  });

  it("rejects non-object payloads", () => {
    expect(isWorkerRequestMessage("sync")).toBe(false);
    expect(isWorkerRequestMessage(42)).toBe(false);
  });
});

describe("isTransientStatus", () => {
  it("returns true for 429 (rate limit)", () => {
    expect(isTransientStatus(429)).toBe(true);
  });

  it("returns true for 5xx server errors", () => {
    expect(isTransientStatus(500)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(599)).toBe(true);
  });

  it("returns false for 2xx, 401 and other 4xx", () => {
    expect(isTransientStatus(200)).toBe(false);
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
    expect(isTransientStatus(418)).toBe(false);
  });
});

describe("delay", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves after the requested milliseconds (fake timers, no real wait)", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const pending = delay(1000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(resolved).toBe(true);
  });
});

// Task 1 (hide-unplayable-formats): the full-sync pass ends with a one-time
// cleanup that deletes already-synced rows whose extension is NOT in the
// playable set. Every shipped extension is playable now (mp3/flac/wav/ogg/m4a/
// aac/opus/wma/aif/aiff/oga/m4b/ape/wv/tak/dsf/dff), so the sample shape is
// `.wvx` — a WavPack look-alike that is NOT in the allowlist. Folders are never
// touched (folder rows have no playable extension but isFolder=true).
describe("full-sync cleanup of non-playable rows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deletes stale non-playable rows at full-sync completion, keeps folders and playable files", async () => {
    await db.files.bulkPut([
      {
        id: "wvx1",
        name: "old-song.wvx",
        mimeType: "audio/x-wavpack",
        parentId: "root",
        size: 1,
        trashed: false,
        isFolder: false,
        userEmail: FIXTURE_EMAIL,
      },
      {
        id: "flac1",
        name: "song.flac",
        mimeType: "audio/flac",
        parentId: "root",
        size: 2,
        trashed: false,
        isFolder: false,
        userEmail: FIXTURE_EMAIL,
      },
      {
        id: "folder1",
        name: "Album Folder",
        mimeType: "application/vnd.google-apps.folder",
        parentId: "root",
        trashed: false,
        isFolder: true,
        userEmail: FIXTURE_EMAIL,
      },
    ]);

    const posted: Array<{ type: string }> = [];
    vi.stubGlobal("self", {
      postMessage: (msg: { type: string }) => {
        posted.push(msg);
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-1" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                id: "flac2",
                name: "new.flac",
                mimeType: "audio/flac",
                parents: ["root"],
                size: "3",
                modifiedTime: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "test-token", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(await db.files.get([FIXTURE_EMAIL, "wvx1"])).toBeUndefined();
    expect(await db.files.get([FIXTURE_EMAIL, "flac1"])).toBeDefined();
    expect(await db.files.get([FIXTURE_EMAIL, "flac2"])).toBeDefined();
    expect(await db.files.get([FIXTURE_EMAIL, "folder1"])).toBeDefined();
    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
    // Success tail: exactly one terminal event, and it is COMPLETE.
    expect(posted.filter((m) => m.type === "SYNC_COMPLETE")).toHaveLength(1);
    expect(posted).not.toContainEqual({ type: "SYNC_ERROR" });
  });

  // Schema v10 keys filesV2 by [userEmail+id]: the table is shared across
  // accounts, so the completion cleanup MUST be scoped to the account being
  // synced. Another account's stale-but-real non-playable rows belong to THEIR
  // mirror — deleting them here would corrupt their library until their own
  // next full sync re-fetches everything.
  it("deletes ONLY the synced account's non-playable rows; another account's rows survive", async () => {
    await resetSyncTables();
    const OTHER_EMAIL = "other-account@example.com";
    await db.files.bulkPut([
      {
        id: "wvx-A",
        name: "mine.wvx",
        mimeType: "audio/x-wavpack",
        parentId: "root",
        size: 1,
        trashed: false,
        isFolder: false,
        userEmail: FIXTURE_EMAIL,
      },
      {
        id: "folder-A",
        name: "Mine Folder",
        mimeType: "application/vnd.google-apps.folder",
        parentId: "root",
        trashed: false,
        isFolder: true,
        userEmail: FIXTURE_EMAIL,
      },
      {
        id: "wvx-B",
        name: "theirs.wvx",
        mimeType: "audio/x-wavpack",
        parentId: "root",
        size: 1,
        trashed: false,
        isFolder: false,
        userEmail: OTHER_EMAIL,
      },
    ]);

    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-scope" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [audioFileRow("flac-A")] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-scope", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
    // Account A: its stale non-playable row goes...
    expect(await db.files.get([FIXTURE_EMAIL, "wvx-A"])).toBeUndefined();
    // ...its folder and freshly synced playable row stay.
    expect(await db.files.get([FIXTURE_EMAIL, "folder-A"])).toBeDefined();
    expect(await db.files.get([FIXTURE_EMAIL, "flac-A"])).toBeDefined();
    // Account B was NOT being synced — its identical non-playable row survives.
    expect(await db.files.get([OTHER_EMAIL, "wvx-B"])).toBeDefined();
  });
});

describe("fetchDrive transient retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function stubFetch(...responses: Response[]) {
    const mock = vi.fn();
    responses.forEach((r) => mock.mockResolvedValueOnce(r));
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("returns the response on first success without retrying", async () => {
    const fetchMock = stubFetch(new Response("{}", { status: 200 }));
    const res = await fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 once and returns the successful second response", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubFetch(
      new Response("{}", { status: 429 }),
      new Response("{}", { status: 200 }),
    );
    const pending = fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries at most MAX_TRANSIENT_RETRIES times (3 attempts total) on persistent 503, then returns the last response", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubFetch(
      new Response("{}", { status: 503 }),
      new Response("{}", { status: 503 }),
      new Response("{}", { status: 503 }),
    );
    const pending = fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 403 with reason rateLimitExceeded once and returns the successful second response", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          error: { errors: [{ reason: "rateLimitExceeded" }], code: 403 },
        }),
        { status: 403 },
      ),
      new Response("{}", { status: 200 }),
    );
    const pending = fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 403 with reason userRateLimitExceeded (per-user Drive limit)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          error: {
            errors: [
              { domain: "usageLimits", reason: "userRateLimitExceeded" },
            ],
            code: 403,
          },
        }),
        { status: 403 },
      ),
      new Response("{}", { status: 200 }),
    );
    const pending = fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 403 with a non-rate-limit reason (accessNotConfigured) — one call, response body still usable", async () => {
    const fetchMock = stubFetch(
      new Response(
        JSON.stringify({
          error: { errors: [{ reason: "accessNotConfigured" }], code: 403 },
        }),
        { status: 403 },
      ),
    );
    const res = await fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual({
      error: { errors: [{ reason: "accessNotConfigured" }], code: 403 },
    });
  });

  it("does not retry a 403 whose body is not a JSON rate-limit error", async () => {
    const fetchMock = stubFetch(
      new Response("plain text body", { status: 403 }),
    );
    const res = await fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 401 — returns it immediately for the call-site token-refresh flow", async () => {
    const fetchMock = stubFetch(new Response("{}", { status: 401 }));
    const res = await fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry other 4xx statuses", async () => {
    const fetchMock = stubFetch(new Response("{}", { status: 404 }));
    const res = await fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors the Retry-After header as the retry delay (seconds form)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubFetch(
      new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
      new Response("{}", { status: 200 }),
    );
    const pending = fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps a huge Retry-After at MAX_RETRY_DELAY_MS (8000ms)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubFetch(
      new Response("{}", { status: 503, headers: { "Retry-After": "99999" } }),
      new Response("{}", { status: 200 }),
    );
    const pending = fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    await vi.advanceTimersByTimeAsync(8000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("jitter = 0 when Math.random() is 0 (delay stays exactly at the backoff base)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = stubFetch(
      new Response("{}", { status: 429 }),
      new Response("{}", { status: 200 }),
    );
    const pending = fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("jitter stays within 0..RETRY_JITTER_MAX_MS (500ms) for the maximum random value", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const fetchMock = stubFetch(
      new Response("{}", { status: 429 }),
      new Response("{}", { status: 200 }),
    );
    const pending = fetchDrive(
      "files",
      "token",
      new URL("https://drive.test/files"),
    );
    await vi.advanceTimersByTimeAsync(1499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Phase B fixes (23/08/2026) — full/delta pagination + honest signaling.
//
// Previously untested region ("vùng mù"): a multi-page full-sync driven
// through mocked fetch responses, including the 401-mid-pagination path.
// The tests below drive performFullSync/performDeltaSync indirectly via the
// exported handleWorkerMessage entry point and answer the worker's
// TOKEN_EXPIRED post with a "token" message — exactly what proSyncManager on
// the main thread does in production.
// ---------------------------------------------------------------------------

const START_PAGE_TOKEN_KEY_LOCAL = "startPageToken";

function audioFileRow(id: string): Record<string, unknown> {
  return {
    id,
    name: `${id}.mp3`,
    mimeType: "audio/mpeg",
    parents: ["root"],
    size: "10",
    modifiedTime: "2026-01-01T00:00:00.000Z",
  };
}

async function resetSyncTables(): Promise<void> {
  await db.files.clear();
  await db.syncState.clear();
}

// Stubs the worker-global `self` so posted messages are collected and replies
// to TOKEN_EXPIRED with a refreshed token (the main thread's production role).
function stubSelfWithTokenReply(freshToken: string): Array<{ type: string }> {
  const posted: Array<{ type: string }> = [];
  vi.stubGlobal("self", {
    postMessage: (msg: { type: string }) => {
      posted.push(msg);
      if (msg.type === "TOKEN_EXPIRED") {
        setTimeout(() => {
          void handleWorkerMessage({
            data: { type: "token", token: freshToken },
          } as MessageEvent);
        }, 0);
      }
    },
  });
  return posted;
}

// Stubs the worker-global `self` so posted messages are collected and replies
// to TOKEN_EXPIRED with refresh_failed (the main thread's "cannot refresh"
// production role — refreshTokenAndRetry resolves false, no fresh token).
function stubSelfWithRefreshFailedReply(): Array<{ type: string }> {
  const posted: Array<{ type: string }> = [];
  vi.stubGlobal("self", {
    postMessage: (msg: { type: string }) => {
      posted.push(msg);
      if (msg.type === "TOKEN_EXPIRED") {
        setTimeout(() => {
          void handleWorkerMessage({
            data: { type: "refresh_failed" },
          } as MessageEvent);
        }, 0);
      }
    },
  });
  return posted;
}

describe("full-sync retries the same page after a mid-sync 401 refresh", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("syncs ALL pages when the FIRST page hits 401 and the token refresh succeeds", async () => {
    await resetSyncTables();
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-1" }), {
          status: 200,
        }),
      )
      // First files page arrives stale — the main thread refreshes the token.
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      // Same page retried with the fresh token; two pages total this run.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [audioFileRow("p1a")],
            nextPageToken: "pg2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [audioFileRow("p2a")] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-a", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(await db.files.get([FIXTURE_EMAIL, "p1a"])).toBeDefined();
    expect(await db.files.get([FIXTURE_EMAIL, "p2a"])).toBeDefined();
    expect(posted).toContainEqual({ type: "SYNC_PROGRESS" });
    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
    // startPageToken lookup + page 1 twice (401 then same-page retry) + page 2.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-1" }),
    );
  });

  it("delta-sync refetches the SAME changes page after a successful refresh (lock invariant)", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [
              {
                fileId: "dx1",
                file: {
                  id: "dx1",
                  name: "dx1.mp3",
                  mimeType: "audio/mpeg",
                  parents: ["root"],
                },
              },
            ],
            newStartPageToken: "start-new",
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-b", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both attempts carry the SAME pageToken — the retry never skips a page.
    const pageTokens = fetchMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get("pageToken"),
    );
    expect(pageTokens).toEqual(["start-old", "start-old"]);
    expect(await db.files.get([FIXTURE_EMAIL, "dx1"])).toBeDefined();
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-new" }),
    );
    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
  });
});

describe("sync storage invariant (no root fallback for unverified parents)", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("does not persist a buildOwnerRow row whose Drive response omits parents", async () => {
    await resetSyncTables();
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-inv" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                id: "no-parent",
                name: "no-parent.mp3",
                mimeType: "audio/mpeg",
              },
              audioFileRow("with-parent"),
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-inv", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    // The whole-library query can return shared items without a usable parent;
    // the invariant skips them instead of planting them under "root".
    expect(await db.files.get([FIXTURE_EMAIL, "no-parent"])).toBeUndefined();
    expect(await db.files.get([FIXTURE_EMAIL, "with-parent"])).toBeDefined();
    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
  });

  it("does not persist a delta change whose file omits parents", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-delta-inv",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          changes: [
            {
              fileId: "delta-no-parent",
              file: {
                id: "delta-no-parent",
                name: "x.mp3",
                mimeType: "audio/mpeg",
              },
            },
            {
              fileId: "delta-with-parent",
              file: {
                id: "delta-with-parent",
                name: "y.mp3",
                mimeType: "audio/mpeg",
                parents: ["root"],
              },
            },
          ],
          newStartPageToken: "start-delta-next",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-delta-inv", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(
      await db.files.get([FIXTURE_EMAIL, "delta-no-parent"]),
    ).toBeUndefined();
    expect(
      await db.files.get([FIXTURE_EMAIL, "delta-with-parent"]),
    ).toBeDefined();
    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
  });
});

describe("full-sync reports SYNC_ERROR when a later page fails to parse", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("posts SYNC_ERROR (never COMPLETE) and does NOT persist the fresh start token", async () => {
    await resetSyncTables();
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-9" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [audioFileRow("bp1")],
            nextPageToken: "pg2",
          }),
          { status: 200 },
        ),
      )
      // Page 2 of 2 returns a body that is not valid JSON → parseDriveJson throws.
      .mockResolvedValueOnce(new Response("<not-json>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-c" },
    } as MessageEvent);

    expect(posted).toContainEqual({ type: "SYNC_ERROR" });
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
  });
});

describe("full-sync reports SYNC_ERROR when bulkPut fails mid-sync", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("posts SYNC_ERROR (never COMPLETE) and does NOT persist the fresh start token", async () => {
    await resetSyncTables();
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-8" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [audioFileRow("bf1")] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(db.files, "bulkPut").mockRejectedValueOnce(
      new Error("simulated bulkPut failure"),
    );

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-d" },
    } as MessageEvent);

    expect(posted).toContainEqual({ type: "SYNC_ERROR" });
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
  });
});

describe("full-sync reports SYNC_ERROR when a pagination page returns an HTTP failure", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("mid-pagination 400: posts SYNC_ERROR (never COMPLETE), does NOT persist the fresh start token, keeps page-1 rows", async () => {
    await resetSyncTables();
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-1" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [audioFileRow("p1a")],
            nextPageToken: "pg2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-mid400", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(posted).toContainEqual({ type: "SYNC_ERROR" });
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    // A partially synced library must not be branded complete: persisting
    // start-1 here would permanently skip the un-fetched [pg2…] pages.
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
    // Already-persisted page-1 rows stay (the replay is idempotent bulkPut).
    expect(await db.files.get([FIXTURE_EMAIL, "p1a"])).toBeDefined();
  });

  it("first-page 400: posts SYNC_ERROR, does NOT save the token and does NOT run the non-playable cleanup", async () => {
    await resetSyncTables();
    await db.files.bulkPut([
      {
        id: "wvx-old",
        name: "old.wvx",
        mimeType: "audio/x-wavpack",
        parentId: "root",
        size: 1,
        trashed: false,
        isFolder: false,
        userEmail: FIXTURE_EMAIL,
      },
    ]);
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-2" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-first400" },
    } as MessageEvent);

    expect(posted).toContainEqual({ type: "SYNC_ERROR" });
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
    // Cleanup only ever runs at full-sync COMPLETION — a failed pass with a
    // zero-page library must not mass-delete rows it never refreshed.
    expect(await db.files.get([FIXTURE_EMAIL, "wvx-old"])).toBeDefined();
  });
});

describe("delta-sync reports SYNC_ERROR instead of advancing or stalling on an HTTP failure", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("mid-pagination 400 after a newStartPageToken: posts SYNC_ERROR (never COMPLETE), keeps the OLD stored token", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [
              {
                fileId: "d1",
                file: { id: "d1", name: "d1.mp3", mimeType: "audio/mpeg" },
              },
            ],
            newStartPageToken: "start-mid",
            nextPageToken: "pg2",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-delta400" },
    } as MessageEvent);

    expect(posted).toContainEqual({ type: "SYNC_ERROR" });
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    // An earlier page already delivered start-mid, but page 2 never arrived:
    // advancing the cursor here would permanently skip the un-fetched window.
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-old" }),
    );
  });

  it("first-page 400: posts SYNC_ERROR and keeps the stored token untouched", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-keep",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-delta-first400" },
    } as MessageEvent);

    expect(posted).toContainEqual({ type: "SYNC_ERROR" });
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-keep" }),
    );
  });
});

describe("worker releases its 401 wait when the main thread cannot refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resolves the pending token-refresh wait with false immediately on a refresh_failed reply (was: stalled until the timeout)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("self", { postMessage: () => {} });
    const state: SyncRetryState = { count: 0, max: 3 };

    const pending = refreshTokenAndRetry(
      state,
      syncRetryDeps,
      "full-sync/files",
    );
    await handleWorkerMessage({
      data: { type: "refresh_failed" },
    } as MessageEvent);

    await expect(pending).resolves.toBe(false);
    expect(state.count).toBe(1);
  });

  it("a sync whose refresh fails posts SYNC_ERROR through the honest exit path", async () => {
    const posted = stubSelfWithRefreshFailedReply();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-f" }), {
          status: 200,
        }),
      )
      .mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-norefresh" },
    } as MessageEvent);

    expect(posted).toContainEqual({ type: "SYNC_ERROR" });
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
  });
});

// B18-4: every failed pass must end with EXACTLY ONE terminal signal, owned
// by the CALLER (fullSync/deltaSync), never by the shared 401 helper. Before
// this fix the budget-exhausted path double-posted SYNC_ERROR (helper + files
// loop) while the startPageToken exits posted ZERO.
describe("terminal signals: exactly one SYNC_ERROR per failed pass", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    syncRetry.count = 0;
    await resetSyncTables();
  });

  function countSyncErrors(posted: Array<{ type: string }>): number {
    return posted.filter((m) => m.type === "SYNC_ERROR").length;
  }

  it("start-pageToken 401 whose refresh fails posts exactly one SYNC_ERROR", async () => {
    await resetSyncTables();
    syncRetry.count = 0;
    const posted = stubSelfWithRefreshFailedReply();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-start401", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(countSyncErrors(posted)).toBe(1);
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
  });

  it("start-pageToken network failure (fetch rejects) posts exactly one SYNC_ERROR", async () => {
    await resetSyncTables();
    syncRetry.count = 0;
    const posted = stubSelfWithRefreshFailedReply();
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-net-down", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(countSyncErrors(posted)).toBe(1);
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
  });

  it("budget-exhausted 401 at the files loop posts exactly one SYNC_ERROR (no double signal)", async () => {
    await resetSyncTables();
    syncRetry.count = 3; // budget already exhausted (sticky across passes)
    const posted = stubSelfWithRefreshFailedReply();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-x" }), {
          status: 200,
        }),
      )
      .mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-budget", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(countSyncErrors(posted)).toBe(1);
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
  });
});

// B18-5: a successful token refresh is NOT enough — a token that Drive keeps
// rejecting must not loop forever. The shared budget resets to 0 on every
// successful refresh, so the per-call ceiling (MAX_AUTH_RETRIES_PER_CALL = 3)
// is what bounds the 401 → refresh → retry sequence.
describe("bounded 401 auth retries per call", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    syncRetry.count = 0;
    await resetSyncTables();
  });

  it("stops refreshing at the ceiling even when the NEXT response would succeed (bound is per call)", async () => {
    await resetSyncTables();
    syncRetry.count = 0;
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ startPageToken: "start-late" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-401-bound", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    // 1 initial attempt + 3 bounded auth retries, then give up honestly —
    // the unbounded loop used to keep refreshing until the 200 arrived.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(posted.filter((m) => m.type === "SYNC_ERROR")).toHaveLength(1);
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toBeUndefined();
  });

  it("gives up on an always-401 Drive even though every refresh succeeds", async () => {
    await resetSyncTables();
    syncRetry.count = 0;
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-401-loop", userEmail: FIXTURE_EMAIL },
    } as MessageEvent);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(posted.filter((m) => m.type === "SYNC_ERROR")).toHaveLength(1);
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
  });
});

// B19-5: the ceiling log must report the REAL exit reason. The loop stops at
// MAX_AUTH_RETRIES_PER_CALL either because every refresh succeeded yet Drive
// kept rejecting the token (a real ceiling) or because the LAST refresh
// failed (break). Only the first case may log "max-auth-attempts-per-call".
describe("auth-ceiling log names the real exit reason", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    syncRetry.count = 0;
    await resetSyncTables();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Answers each TOKEN_EXPIRED with the next scripted reply: a token string
  // refreshes successfully, "refresh_failed" releases the wait as false.
  function stubScriptedRefreshReplies(
    replies: string[],
  ): Array<{ type: string }> {
    const posted: Array<{ type: string }> = [];
    let call = 0;
    vi.stubGlobal("self", {
      postMessage: (msg: { type: string }) => {
        posted.push(msg);
        if (msg.type === "TOKEN_EXPIRED") {
          const reply =
            replies[Math.min(call, replies.length - 1)] ?? "refresh_failed";
          call += 1;
          setTimeout(() => {
            void handleWorkerMessage({
              data:
                reply === "refresh_failed"
                  ? { type: "refresh_failed" }
                  : { type: "token", token: reply },
            } as MessageEvent);
          }, 0);
        }
      },
    });
    return posted;
  }

  function ceilingLogCalls(): number {
    return vi
      .mocked(captureError)
      .mock.calls.filter((call) =>
        call[0].message.includes("max-auth-attempts-per-call"),
      ).length;
  }

  it("does NOT log the ceiling when the loop stops because the LAST refresh failed", async () => {
    await resetSyncTables();
    syncRetry.count = 0;
    const posted = stubScriptedRefreshReplies([
      "fresh-1",
      "fresh-2",
      "refresh_failed",
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: {
        type: "sync",
        token: "tok-last-fail",
        userEmail: FIXTURE_EMAIL,
      },
    } as MessageEvent);

    // 1 initial fetch + one refetch after each of the 2 successful refreshes;
    // the third refresh fails → break, response is still the previous 401.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(ceilingLogCalls()).toBe(0);
    expect(posted.filter((m) => m.type === "SYNC_ERROR")).toHaveLength(1);
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
  });

  it("logs the ceiling exactly once when refresh keeps succeeding but Drive always answers 401", async () => {
    await resetSyncTables();
    syncRetry.count = 0;
    const posted = stubScriptedRefreshReplies([
      "fresh-1",
      "fresh-2",
      "fresh-3",
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: {
        type: "sync",
        token: "tok-real-ceiling",
        userEmail: FIXTURE_EMAIL,
      },
    } as MessageEvent);

    // 1 initial fetch + 3 bounded auth retries, then give up honestly.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(ceilingLogCalls()).toBe(1);
    expect(posted.filter((m) => m.type === "SYNC_ERROR")).toHaveLength(1);
    expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
  });
});

// ---------------------------------------------------------------------------
// Schema v10 per-account stamping: the sync wire frame carries the owning
// account's email and EVERY persisted row is keyed [userEmail+id]. A sync
// frame without a real account email (missing, empty, or the shared "default"
// sentinel) must be rejected with SYNC_ERROR BEFORE any write — stamping the
// library with "default" is the exact cross-account-leak shape schema v10
// exists to prevent.
// ---------------------------------------------------------------------------
const WIRE_EMAIL = "user-a@x";

function ownedRow(id: string): DriveFile {
  return {
    id,
    name: `${id}.mp3`,
    mimeType: "audio/mpeg",
    parentId: "root",
    size: 10,
    trashed: false,
    isFolder: false,
    userEmail: WIRE_EMAIL,
  };
}

describe("sync stamps every row with the userEmail from the wire frame", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("full-sync persists rows under [userEmail+id] from the message, never under 'default'", async () => {
    await resetSyncTables();
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startPageToken: "start-a" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [audioFileRow("ua1")] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-owner", userEmail: WIRE_EMAIL },
    } as MessageEvent);

    expect(await db.files.get([WIRE_EMAIL, "ua1"])).toBeDefined();
    expect(await db.files.get([DEFAULT_USER_EMAIL, "ua1"])).toBeUndefined();
    expect(await db.files.count()).toBe(1);
    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
  });

  it("delta-sync applies changes under the message email (put) and deletes by [userEmail+id]", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    await db.files.bulkPut([ownedRow("del-me")]);
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          changes: [
            {
              fileId: "dx9",
              file: {
                id: "dx9",
                name: "dx9.mp3",
                mimeType: "audio/mpeg",
                parents: ["root"],
              },
            },
            { fileId: "del-me", removed: true },
          ],
          newStartPageToken: "start-new",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "tok-delta-owner", userEmail: WIRE_EMAIL },
    } as MessageEvent);

    // Put landed under the real account...
    expect(await db.files.get([WIRE_EMAIL, "dx9"])).toBeDefined();
    expect(await db.files.get([DEFAULT_USER_EMAIL, "dx9"])).toBeUndefined();
    // ...and the removal deleted by the SAME account's compound key.
    expect(await db.files.get([WIRE_EMAIL, "del-me"])).toBeUndefined();
    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
  });
});

describe("sync without a usable owner email is rejected before any write", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it.each([
    ["missing userEmail", undefined],
    ["empty userEmail", ""],
    ["sentinel userEmail", DEFAULT_USER_EMAIL],
  ])(
    "%s: posts SYNC_ERROR (never COMPLETE) and writes ZERO rows",
    async (_label, userEmail) => {
      await resetSyncTables();
      const posted = stubSelfWithTokenReply("fresh-token");
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ startPageToken: "start-z" }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ files: [audioFileRow("uz1")] }), {
            status: 200,
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      await handleWorkerMessage({
        data:
          userEmail === undefined
            ? { type: "sync", token: "tok-gate" }
            : { type: "sync", token: "tok-gate", userEmail },
      } as MessageEvent);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(posted).toContainEqual({ type: "SYNC_ERROR" });
      expect(posted).not.toContainEqual({ type: "SYNC_COMPLETE" });
      expect(await db.files.count()).toBe(0);
      // The gate must not consume the run either — no cursor was advanced.
      expect(
        await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL),
      ).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Delta-sync apply integrity (cursor never advances past an unapplied change).
//
// Before this fix the per-change catch only logged: the run still saved
// newStartPageToken and posted SYNC_COMPLETE, so the poller permanently
// skipped changes the mirror never received. The unsupported-file branch was
// missing entirely, so an mp3 renamed to .txt/.pdf left its stale row in the
// mirror forever. These tests drive performDeltaSync/performFullSync directly
// (the token is primed through the same "token" wire frame the main thread
// sends on rotation) so each invariant is pinned without runSync's
// full-vs-delta decision.
// ---------------------------------------------------------------------------
const DELTA_OWNER = "delta-owner@example.com";
const OTHER_DELTA_OWNER = "other-delta@example.com";

function postedCount(posted: Array<{ type: string }>, type: string): number {
  return posted.filter((m) => m.type === type).length;
}

function deltaFileChange(id: string, name: string, mimeType = "audio/mpeg") {
  return {
    fileId: id,
    file: { id, name, mimeType, parents: ["root"] },
  };
}

function deltaFolderChange(id: string, name: string) {
  return {
    fileId: id,
    file: {
      id,
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    },
  };
}

async function primeWorkerToken(token: string): Promise<void> {
  await handleWorkerMessage({
    data: { type: "token", token },
  } as MessageEvent);
}

function seedTokenRow(id: string, name: string, email: string) {
  return {
    id,
    name,
    mimeType: "audio/mpeg",
    parentId: "root",
    size: 1,
    trashed: false,
    isFolder: false,
    userEmail: email,
  };
}

describe("delta-sync apply integrity (Group A)", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("A1: file upsert failure posts exactly one SYNC_ERROR, zero COMPLETE and keeps the previous token", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [deltaFileChange("a1", "a1.mp3")],
            newStartPageToken: "start-new",
          }),
          { status: 200 },
        ),
      ),
    );
    vi.spyOn(db.files, "bulkPut").mockRejectedValueOnce(
      new Error("simulated upsert failure"),
    );

    await primeWorkerToken("tok-a1");
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(postedCount(posted, "SYNC_ERROR")).toBe(1);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(0);
    // The failed change was never applied, so the window must be replayed.
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-old" }),
    );
    expect(await db.files.get([DELTA_OWNER, "a1"])).toBeUndefined();
  });

  it("A2: removal delete failure posts exactly one SYNC_ERROR, zero COMPLETE and keeps the previous token", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    await db.files.put(seedTokenRow("a2", "a2.mp3", DELTA_OWNER));
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [{ fileId: "a2", removed: true }],
            newStartPageToken: "start-new",
          }),
          { status: 200 },
        ),
      ),
    );
    vi.spyOn(db.files, "delete").mockRejectedValueOnce(
      new Error("simulated delete failure"),
    );

    await primeWorkerToken("tok-a2");
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(postedCount(posted, "SYNC_ERROR")).toBe(1);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(0);
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-old" }),
    );
    // The undeleted row is exactly why the cursor must stay put.
    expect(await db.files.get([DELTA_OWNER, "a2"])).toBeDefined();
  });

  it("A3: a failure after an earlier successful change keeps that write but never advances the token", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    await db.files.put(seedTokenRow("a3-del", "a3-del.mp3", DELTA_OWNER));
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [
              deltaFileChange("a3-new", "a3-new.mp3"),
              { fileId: "a3-del", removed: true },
            ],
            newStartPageToken: "start-new",
          }),
          { status: 200 },
        ),
      ),
    );
    vi.spyOn(db.files, "delete").mockRejectedValueOnce(
      new Error("simulated delete failure"),
    );

    await primeWorkerToken("tok-a3");
    await performDeltaSync("start-old", DELTA_OWNER);

    // Per-change isolation: the first change landed.
    expect(await db.files.get([DELTA_OWNER, "a3-new"])).toBeDefined();
    expect(postedCount(posted, "SYNC_ERROR")).toBe(1);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(0);
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-old" }),
    );
  });

  it("A4: failed pass then clean replay converges the mirror and advances the token only on the replay", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    await db.files.put(seedTokenRow("a4-del", "a4-del.mp3", DELTA_OWNER));
    const posted = stubSelfWithTokenReply("fresh-token");
    const changesPayload = JSON.stringify({
      changes: [
        deltaFileChange("a4-new", "a4-new.mp3"),
        { fileId: "a4-del", removed: true },
      ],
      newStartPageToken: "start-new",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        return Promise.resolve(new Response(changesPayload, { status: 200 }));
      }),
    );

    await primeWorkerToken("tok-a4");
    vi.spyOn(db.files, "delete").mockRejectedValueOnce(
      new Error("simulated delete failure"),
    );
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(postedCount(posted, "SYNC_ERROR")).toBe(1);
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-old" }),
    );

    // The next poll replays the very same window (old token) — now cleanly.
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
    expect(await db.files.get([DELTA_OWNER, "a4-new"])).toBeDefined();
    expect(await db.files.get([DELTA_OWNER, "a4-del"])).toBeUndefined();
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-new" }),
    );
  });
});

describe("delta-sync unsupported-change cleanup (Group B)", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("B1: an mp3 renamed to .txt removes the stale mirror row", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    await db.files.put(seedTokenRow("b1", "song.mp3", DELTA_OWNER));
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [deltaFileChange("b1", "song.txt", "text/plain")],
            newStartPageToken: "start-b1",
          }),
          { status: 200 },
        ),
      ),
    );

    await primeWorkerToken("tok-b1");
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(await db.files.get([DELTA_OWNER, "b1"])).toBeUndefined();
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-b1" }),
    );
  });

  it("B2: a .mp3 renamed to .flac updates the existing row instead of deleting it", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    await db.files.put(seedTokenRow("b2", "song.mp3", DELTA_OWNER));
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [deltaFileChange("b2", "song.flac", "audio/flac")],
            newStartPageToken: "start-b2",
          }),
          { status: 200 },
        ),
      ),
    );

    await primeWorkerToken("tok-b2");
    await performDeltaSync("start-old", DELTA_OWNER);

    const row = await db.files.get([DELTA_OWNER, "b2"]);
    expect(row).toBeDefined();
    expect(row?.name).toBe("song.flac");
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
  });

  it("B3: a folder with no media extension is still persisted, never deleted", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [deltaFolderChange("b3", "Album Folder")],
            newStartPageToken: "start-b3",
          }),
          { status: 200 },
        ),
      ),
    );

    await primeWorkerToken("tok-b3");
    await performDeltaSync("start-old", DELTA_OWNER);

    const row = await db.files.get([DELTA_OWNER, "b3"]);
    expect(row).toBeDefined();
    expect(row?.isFolder).toBe(true);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
  });

  it("B4: the same file id under two accounts — only the synced account's row is removed", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    await db.files.bulkPut([
      seedTokenRow("b4", "shared.mp3", DELTA_OWNER),
      seedTokenRow("b4", "shared.mp3", OTHER_DELTA_OWNER),
    ]);
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [deltaFileChange("b4", "shared.pdf", "application/pdf")],
            newStartPageToken: "start-b4",
          }),
          { status: 200 },
        ),
      ),
    );

    await primeWorkerToken("tok-b4");
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(await db.files.get([DELTA_OWNER, "b4"])).toBeUndefined();
    expect(await db.files.get([OTHER_DELTA_OWNER, "b4"])).toBeDefined();
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
  });

  it("B5: an unsupported change with no existing row is a no-op — no crash, no broad deletion", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    await db.files.put(seedTokenRow("b5-keep", "keep.mp3", DELTA_OWNER));
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [deltaFileChange("b5-absent", "ghost.txt", "text/plain")],
            newStartPageToken: "start-b5",
          }),
          { status: 200 },
        ),
      ),
    );

    await primeWorkerToken("tok-b5");
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(await db.files.get([DELTA_OWNER, "b5-absent"])).toBeUndefined();
    expect(await db.files.get([DELTA_OWNER, "b5-keep"])).toBeDefined();
    expect(await db.files.count()).toBe(1);
    expect(postedCount(posted, "SYNC_ERROR")).toBe(0);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
  });
});

describe("checkpoint persistence is part of success (Groups C and D)", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("C1: a rejected delta checkpoint put posts exactly one SYNC_ERROR and leaves the old token", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [deltaFileChange("c1", "c1.mp3")],
            newStartPageToken: "start-new",
          }),
          { status: 200 },
        ),
      ),
    );
    vi.spyOn(db.syncState, "put").mockRejectedValueOnce(
      new Error("simulated syncState failure"),
    );

    await primeWorkerToken("tok-c1");
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(postedCount(posted, "SYNC_ERROR")).toBe(1);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(0);
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-old" }),
    );
  });

  it("D1: a rejected full-sync checkpoint put posts exactly one SYNC_ERROR, keeps the old token and never reaches the success tail", async () => {
    await resetSyncTables();
    // A real previous token (the pass must not be brandable complete).
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-prev",
    });
    await db.files.put({
      id: "d1-stale",
      name: "stale.wvx",
      mimeType: "audio/x-wavpack",
      parentId: "root",
      size: 1,
      trashed: false,
      isFolder: false,
      userEmail: DELTA_OWNER,
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("startPageToken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ startPageToken: "start-fresh" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ files: [audioFileRow("d1-new")] }), {
            status: 200,
          }),
        );
      }),
    );
    vi.spyOn(db.syncState, "put").mockRejectedValueOnce(
      new Error("simulated syncState failure"),
    );

    await primeWorkerToken("tok-d1");
    await performFullSync(DELTA_OWNER);

    expect(postedCount(posted, "SYNC_ERROR")).toBe(1);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(0);
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-prev" }),
    );
    // The success tail (cleanup sweep) was never reached.
    expect(await db.files.get([DELTA_OWNER, "d1-stale"])).toBeDefined();
  });
});

describe("terminal-signal contracts (Group E)", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetSyncTables();
  });

  it("E1: a successful full sync posts exactly one SYNC_COMPLETE and no SYNC_ERROR", async () => {
    await resetSyncTables();
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("startPageToken")) {
          return Promise.resolve(
            new Response(JSON.stringify({ startPageToken: "start-ok" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ files: [audioFileRow("e1")] }), {
            status: 200,
          }),
        );
      }),
    );

    await primeWorkerToken("tok-e1");
    await performFullSync(DELTA_OWNER);

    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
    expect(postedCount(posted, "SYNC_ERROR")).toBe(0);
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-ok" }),
    );
  });

  it("E2: a successful delta run posts exactly one SYNC_COMPLETE and no SYNC_ERROR", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changes: [deltaFileChange("e2", "e2.mp3")],
            newStartPageToken: "start-e2",
          }),
          { status: 200 },
        ),
      ),
    );

    await primeWorkerToken("tok-e2");
    await performDeltaSync("start-old", DELTA_OWNER);

    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
    expect(postedCount(posted, "SYNC_ERROR")).toBe(0);
    expect(await db.files.get([DELTA_OWNER, "e2"])).toBeDefined();
  });

  it("E3: a no-change run (same startPageToken, no changes) posts exactly one SYNC_COMPLETE and saves nothing", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-same",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ changes: [], newStartPageToken: "start-same" }),
            { status: 200 },
          ),
        ),
    );
    const putSpy = vi.spyOn(db.syncState, "put");

    await primeWorkerToken("tok-e3");
    await performDeltaSync("start-same", DELTA_OWNER);

    // Previously this run posted NOTHING, leaving the poller waiting forever.
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
    expect(postedCount(posted, "SYNC_ERROR")).toBe(0);
    expect(putSpy).not.toHaveBeenCalled();
    expect(await db.syncState.get(START_PAGE_TOKEN_KEY_LOCAL)).toEqual(
      expect.objectContaining({ value: "start-same" }),
    );
  });

  it("E4: a second sync while one is in flight still posts SYNC_BUSY once and completes the first", async () => {
    await resetSyncTables();
    await db.syncState.put({
      key: START_PAGE_TOKEN_KEY_LOCAL,
      value: "start-old",
    });
    const posted = stubSelfWithTokenReply("fresh-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              changes: [deltaFileChange("e4", "e4.mp3")],
              newStartPageToken: "start-e4",
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const first = handleWorkerMessage({
      data: { type: "sync", token: "tok-e4", userEmail: DELTA_OWNER },
    } as MessageEvent);
    const second = handleWorkerMessage({
      data: { type: "sync", token: "tok-e4", userEmail: DELTA_OWNER },
    } as MessageEvent);
    await Promise.all([first, second]);

    expect(postedCount(posted, "SYNC_BUSY")).toBe(1);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(1);
    expect(await db.files.get([DELTA_OWNER, "e4"])).toBeDefined();
  });

  it("E5: a sync frame with an empty token still posts SYNC_NO_TOKEN and fetches nothing", async () => {
    await resetSyncTables();
    const posted = stubSelfWithTokenReply("fresh-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await handleWorkerMessage({
      data: { type: "sync", token: "", userEmail: DELTA_OWNER },
    } as MessageEvent);

    expect(postedCount(posted, "SYNC_NO_TOKEN")).toBe(1);
    expect(postedCount(posted, "SYNC_COMPLETE")).toBe(0);
    expect(postedCount(posted, "SYNC_ERROR")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
