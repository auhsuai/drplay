import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  toDriveFileRow,
} from "./proSync.worker";
import type { SyncRetryState } from "./proSync.worker";
import { syncRetryDeps } from "./tokenRefresh";
import { DEFAULT_USER_EMAIL } from "../utils/storageKeys";

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

describe("toDriveFileRow", () => {
  it("maps a folder to a row with isFolder=true and the folder MIME type", () => {
    const row = toDriveFileRow(
      {
        id: "folder1",
        name: "My Folder",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["parent1"],
        size: "1024",
        modifiedTime: "2026-01-01T00:00:00.000Z",
      },
      true,
    );
    expect(row.isFolder).toBe(true);
    expect(row.mimeType).toBe("application/vnd.google-apps.folder");
  });

  it("maps a regular audio file to a row with isFolder=false", () => {
    const row = toDriveFileRow(
      {
        id: "file1",
        name: "song.mp3",
        mimeType: "audio/mpeg",
        parents: ["parent1"],
        size: "2048",
        modifiedTime: "2026-01-02T00:00:00.000Z",
      },
      false,
    );
    expect(row.isFolder).toBe(false);
    expect(row.mimeType).toBe("audio/mpeg");
  });

  it('falls back to parentId "root" when parents is missing or empty', () => {
    const noParents = toDriveFileRow(
      { id: "a", name: "a.mp3", mimeType: "audio/mpeg" },
      false,
    );
    expect(noParents.parentId).toBe("root");

    const emptyParents = toDriveFileRow(
      { id: "b", name: "b.mp3", mimeType: "audio/mpeg", parents: [] },
      false,
    );
    expect(emptyParents.parentId).toBe("root");
  });

  it("uses the first parent as parentId when parents is present", () => {
    const row = toDriveFileRow(
      { id: "c", name: "c.mp3", mimeType: "audio/mpeg", parents: ["p1", "p2"] },
      false,
    );
    expect(row.parentId).toBe("p1");
  });

  it("converts size via toSize and keeps modifiedTime/trashed as-is", () => {
    const row = toDriveFileRow(
      {
        id: "d",
        name: "d.mp3",
        mimeType: "audio/mpeg",
        parents: ["p1"],
        size: "1048576",
        modifiedTime: "2026-01-03T00:00:00.000Z",
      },
      false,
    );
    expect(row.size).toBe(1048576);
    expect(row.modifiedTime).toBe("2026-01-03T00:00:00.000Z");
    expect(row.trashed).toBe(false);
  });

  it("normalizes an empty/invalid size to undefined", () => {
    expect(
      toDriveFileRow(
        { id: "e", name: "e.mp3", mimeType: "audio/mpeg", size: "" },
        false,
      ).size,
    ).toBeUndefined();
    expect(
      toDriveFileRow({ id: "f", name: "f.mp3", mimeType: "audio/mpeg" }, false)
        .size,
    ).toBeUndefined();
    expect(
      toDriveFileRow(
        {
          id: "g",
          name: "g.mp3",
          mimeType: "audio/mpeg",
          size: "not-a-number",
        },
        false,
      ).size,
    ).toBeUndefined();
  });

  it("produces the exact DB row shape used by full-sync and delta-sync", () => {
    const row = toDriveFileRow(
      {
        id: "h",
        name: "h.flac",
        mimeType: "audio/flac",
        parents: ["p9"],
        size: "42",
        modifiedTime: "2026-01-04T00:00:00.000Z",
      },
      false,
    );
    expect(row).toEqual({
      id: "h",
      name: "h.flac",
      mimeType: "audio/flac",
      parentId: "p9",
      size: 42,
      modifiedTime: "2026-01-04T00:00:00.000Z",
      trashed: false,
      isFolder: false,
    });
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

  it("gives up when count is already at max: returns false and posts SYNC_ERROR, no TOKEN_EXPIRED, no wait", async () => {
    const state = makeState(3, 3);
    const { deps, sent, waitCalls } = makeDeps(true);

    const result = await refreshTokenAndRetry(
      state,
      deps,
      "full-sync/startPageToken",
    );

    expect(result).toBe(false);
    expect(sent).toEqual([{ type: "SYNC_ERROR" }]);
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
// playable set (wma/aiff/alac/ape/dsf/dff/wv/tak), because Chromium/WebView2
// cannot decode them. Folders are never touched (folder rows have no playable
// extension but isFolder=true).
describe("full-sync cleanup of non-playable rows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deletes stale non-playable rows at full-sync completion, keeps folders and playable files", async () => {
    await db.files.bulkPut([
      {
        id: "wma1",
        name: "old-song.wma",
        mimeType: "audio/x-ms-wma",
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

    expect(await db.files.get([FIXTURE_EMAIL, "wma1"])).toBeUndefined();
    expect(await db.files.get([FIXTURE_EMAIL, "flac1"])).toBeDefined();
    expect(await db.files.get([FIXTURE_EMAIL, "flac2"])).toBeDefined();
    expect(await db.files.get([FIXTURE_EMAIL, "folder1"])).toBeDefined();
    expect(posted).toContainEqual({ type: "SYNC_COMPLETE" });
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
        id: "wma-A",
        name: "mine.wma",
        mimeType: "audio/x-ms-wma",
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
        id: "wma-B",
        name: "theirs.wma",
        mimeType: "audio/x-ms-wma",
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
    expect(await db.files.get([FIXTURE_EMAIL, "wma-A"])).toBeUndefined();
    // ...its folder and freshly synced playable row stay.
    expect(await db.files.get([FIXTURE_EMAIL, "folder-A"])).toBeDefined();
    expect(await db.files.get([FIXTURE_EMAIL, "flac-A"])).toBeDefined();
    // Account B was NOT being synced — its identical non-playable row survives.
    expect(await db.files.get([OTHER_EMAIL, "wma-B"])).toBeDefined();
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
                file: { id: "dx1", name: "dx1.mp3", mimeType: "audio/mpeg" },
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
        id: "wma-old",
        name: "old.wma",
        mimeType: "audio/x-ms-wma",
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
    expect(await db.files.get([FIXTURE_EMAIL, "wma-old"])).toBeDefined();
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
              file: { id: "dx9", name: "dx9.mp3", mimeType: "audio/mpeg" },
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
