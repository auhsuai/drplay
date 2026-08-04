import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  delay,
  fetchDrive,
  isTransientStatus,
  isWorkerRequestMessage,
  isValidDriveFile,
  partitionValidFiles,
  refreshTokenAndRetry,
  toDriveFileRow,
} from "./proSync.worker";
import type { SyncRetryState } from "./proSync.worker";

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
      waitForTokenRefresh: async () => {
        waitCalls++;
        return waitResult;
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
