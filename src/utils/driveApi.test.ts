import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  backoffDelay,
  driveFetch,
  searchFolders,
  listFolderChildren,
  getTrashedFiles,
  getDriveStorageQuota,
  uploadFileResumable,
  uploadFileResumableChunked,
  type DriveFolderItem,
  type DriveFileItem,
} from "./driveApi";

// Mock the auth-bound transport so we can simulate Drive API responses and
// exercise driveFetch's retry/backoff path without real network calls.
vi.mock("./apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock("./errorLog", () => ({
  captureError: vi.fn(),
}));

import { fetchWithAuth } from "./apiClient";
import { captureError } from "./errorLog";
const mockedFetch = vi.mocked(fetchWithAuth);

function makeResponse(status: number): Response {
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    headers: { get: () => null },
  } as unknown as Response;
}

function makeJsonResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

describe("backoffDelay", () => {
  it("honors numeric Retry-After in seconds (capped at MAX_DELAY_MS)", () => {
    expect(backoffDelay(0, "5")).toBe(5000);
    expect(backoffDelay(0, "100")).toBe(32000); // 100s > 32s cap
  });

  it("honors Retry-After as an HTTP date when in the future (capped)", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const d = backoffDelay(0, future);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(32000);
  });

  it("ignores an already-expired Retry-After date and falls back to exp backoff", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    const d = backoffDelay(0, past);
    expect(d).toBeGreaterThanOrEqual(1000); // exponential base at attempt 0
  });

  it("uses exponential backoff + jitter bounded at base for attempt 0", () => {
    const d = backoffDelay(0);
    expect(d).toBeGreaterThanOrEqual(1000);
    expect(d).toBeLessThanOrEqual(1500); // 1000 + up to 50% jitter
  });

  it("caps exponential backoff at MAX_DELAY_MS", () => {
    expect(backoffDelay(5)).toBe(32000);
    expect(backoffDelay(10)).toBe(32000);
  });
});

describe("driveFetch retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("retries on 429 then 503 and returns the eventual 200", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(503))
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(200);
  });

  it("retries on a network error and returns the eventual 200", async () => {
    mockedFetch
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("does NOT retry a non-retryable 4xx and returns it immediately", async () => {
    mockedFetch.mockResolvedValueOnce(makeResponse(404));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
  });
});

// Regression: caller-supplied signal must NOT disable the timeout (Bug 1a).
// The combined timeout is faked via AbortSignal.timeout spy so we can advance
// the clock without waiting 20s per attempt in real time.
describe("driveFetch timeout with caller signal (Bug 1a)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () =>
          controller.abort(
            new DOMException("The operation was aborted due to timeout", "TimeoutError")
          ),
        ms
      );
      return controller.signal;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // fetchWithAuth that stalls forever but rejects when the (combined) signal
  // fires — mirrors a real fetch hanging on a stalled network.
  const stallUntilAborted = (): void => {
    mockedFetch.mockImplementation(
      (_url: RequestInfo | URL, opts?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = opts?.signal;
          if (!signal) {
            return; // no bound: leave promise pending
          }
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () =>
            reject(signal.reason ?? new DOMException("aborted", "AbortError"))
          );
        })
    );
  };

  it("still rejects on timeout even when a (non-aborted) caller signal is given", async () => {
    stallUntilAborted();
    const controller = new AbortController();

    const p = driveFetch("https://www.googleapis.com/drive/v3/files", {
      signal: controller.signal,
    });
    const assertion = expect(p).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(200_000);

    await assertion;
    // Timeout fired on every attempt and each one retried as transient —
    // proves the timeout remained effective throughout the retry chain.
    expect(mockedFetch).toHaveBeenCalledTimes(5);
  });
});

// Regression: user-initiated abort must NOT be retried (Bug 1b).
describe("driveFetch caller abort (Bug 1b)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does NOT retry when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    mockedFetch.mockRejectedValue(new DOMException("aborted", "AbortError"));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files", {
      signal: controller.signal,
    });
    const assertion = expect(p).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(200_000);

    await assertion;
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts the retry chain immediately when the caller aborts mid-retry", async () => {
    const controller = new AbortController();
    mockedFetch
      .mockRejectedValueOnce(new Error("network down"))
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      })
      .mockRejectedValue(new DOMException("aborted", "AbortError"));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files", {
      signal: controller.signal,
    });
    const assertion = expect(p).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(200_000);

    await assertion;
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  // Variation guard: only a USER abort stops the retry chain. An AbortError
  // fired by our own merged timeout (caller signal still NOT aborted) must
  // keep retrying as a transient failure — otherwise the 1b fix would also
  // kill retry for genuine timeouts.
  it("still retries a self-generated timeout even when a caller signal exists (caller not aborted)", async () => {
    const controller = new AbortController();
    mockedFetch
      .mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files", {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });
});

// Regression: pagination must aggregate nextPageToken pages (Bug 1c).
describe("searchFolders / listFolderChildren pagination (Bug 1c)", () => {
  beforeEach(() => {
    // Clear stale implementations left by the abort/timeout suites — their
    // default mockRejectedValue would otherwise leak into these tests.
    mockedFetch.mockReset();
  });

  const folder = (id: string, name: string): DriveFolderItem => ({
    id,
    name,
    mimeType: "application/vnd.google-apps.folder",
  });
  const makeFiles = (count: number, prefix: string): DriveFolderItem[] =>
    Array.from({ length: count }, (_, i) => folder(`${prefix}${i}`, `${prefix}${i}`));

  const captureUrls = (pages: Array<{ files: DriveFolderItem[]; nextPageToken?: string }>): string[] => {
    const urls: string[] = [];
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const page = pages[urls.length - 1];
      return makeJsonResponse(200, page);
    });
    return urls;
  };

  it("searchFolders aggregates 2 pages (30 + 5) via nextPageToken", async () => {
    const urls = captureUrls([
      { files: makeFiles(30, "s"), nextPageToken: "tok2" },
      { files: makeFiles(5, "x") },
    ]);

    const result = await searchFolders("tok", "name contains 'foo'");

    expect(result).toHaveLength(35);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(urls[1]).toContain("pageToken=tok2");
  });

  it("listFolderChildren aggregates 3 pages (30 + 30 + 5) via nextPageToken", async () => {
    const urls = captureUrls([
      { files: makeFiles(30, "a"), nextPageToken: "tok2" },
      { files: makeFiles(30, "b"), nextPageToken: "tok3" },
      { files: makeFiles(5, "c") },
    ]);

    const result = await listFolderChildren("tok", "folderId");

    expect(result).toHaveLength(65);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(urls[1]).toContain("pageToken=tok2");
    expect(urls[2]).toContain("pageToken=tok3");
  });

  it("searchFolders returns a single page when no nextPageToken is present", async () => {
    const urls = captureUrls([{ files: makeFiles(3, "z") }]);

    const result = await searchFolders("tok", "name contains 'foo'");

    expect(result).toHaveLength(3);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(urls[0]).not.toContain("pageToken=");
  });

  // Variation: a server that keeps handing out nextPageToken forever must not
  // turn the loop into an infinite fetch — it stops at MAX_PAGINATION_PAGES.
  it("searchFolders stops at the pagination page cap instead of looping forever", async () => {
    const pages = Array.from({ length: 12 }, () => ({
      files: makeFiles(30, "cap"),
      nextPageToken: "next",
    }));
    captureUrls(pages);

    const result = await searchFolders("tok", "name contains 'foo'");

    // 10 pages = MAX_PAGINATION_PAGES cap in driveApi.ts; the 11th+ must not fire.
    expect(mockedFetch).toHaveBeenCalledTimes(10);
    expect(result).toHaveLength(300);
  });

  // Variation: caller abort between pages must break cleanly — no extra fetch,
  // no thrown rejection, accumulated pages returned.
  it("searchFolders breaks cleanly when the caller aborts between pages", async () => {
    const controller = new AbortController();
    mockedFetch.mockImplementation(async () => {
      if (!controller.signal.aborted) controller.abort();
      return makeJsonResponse(200, { files: makeFiles(30, "brk"), nextPageToken: "tok2" });
    });

    const result = await searchFolders("tok", "name contains 'foo'", controller.signal);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(30);
  });
});

// Regression: getTrashedFiles must paginate too. It used a single request with
// no pageSize and no nextPageToken loop, so trash with more than one page of
// results (Drive caps each request) was silently truncated in TrashScreen.
describe("getTrashedFiles pagination (trash truncation)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const trashed = (id: string, name: string): DriveFileItem => ({
    id,
    name,
    mimeType: "audio/mpeg",
  });
  const makeTrashed = (count: number, prefix: string): DriveFileItem[] =>
    Array.from({ length: count }, (_, i) => trashed(`${prefix}${i}`, `${prefix}${i}`));

  const captureTrashedUrls = (pages: Array<{ files: DriveFileItem[]; nextPageToken?: string }>): string[] => {
    const urls: string[] = [];
    mockedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const page = pages[urls.length - 1];
      return makeJsonResponse(200, page);
    });
    return urls;
  };

  it("aggregates 2 pages (30 + 5) via nextPageToken", async () => {
    const urls = captureTrashedUrls([
      { files: makeTrashed(30, "t"), nextPageToken: "tok2" },
      { files: makeTrashed(5, "u") },
    ]);

    const result = await getTrashedFiles("tok", "trashed=true");

    expect(result).toHaveLength(35);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(urls[1]).toContain("pageToken=tok2");
  });

  it("aggregates 3 pages (30 + 30 + 5) via nextPageToken", async () => {
    const urls = captureTrashedUrls([
      { files: makeTrashed(30, "a"), nextPageToken: "tok2" },
      { files: makeTrashed(30, "b"), nextPageToken: "tok3" },
      { files: makeTrashed(5, "c") },
    ]);

    const result = await getTrashedFiles("tok", "trashed=true");

    expect(result).toHaveLength(65);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(urls[1]).toContain("pageToken=tok2");
    expect(urls[2]).toContain("pageToken=tok3");
  });

  it("returns a single page when no nextPageToken is present", async () => {
    const urls = captureTrashedUrls([{ files: makeTrashed(3, "z") }]);

    const result = await getTrashedFiles("tok", "trashed=true");

    expect(result).toHaveLength(3);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(urls[0]).not.toContain("pageToken=");
  });

  // Variation: a server that keeps issuing nextPageToken forever must stop at
  // MAX_PAGINATION_PAGES instead of looping (same guard as the folder helpers).
  it("stops at the pagination page cap instead of looping forever", async () => {
    const pages = Array.from({ length: 12 }, () => ({
      files: makeTrashed(30, "cap"),
      nextPageToken: "next",
    }));
    captureTrashedUrls(pages);

    const result = await getTrashedFiles("tok", "trashed=true");

    // 10 pages = MAX_PAGINATION_PAGES cap in driveApi.ts; the 11th+ must not fire.
    expect(mockedFetch).toHaveBeenCalledTimes(10);
    expect(result).toHaveLength(300);
  });

  // Variation: caller abort between pages must break cleanly — no extra fetch,
  // no thrown rejection, accumulated pages returned.
  it("breaks cleanly when the caller aborts between pages", async () => {
    const controller = new AbortController();
    mockedFetch.mockImplementation(async () => {
      if (!controller.signal.aborted) controller.abort();
      return makeJsonResponse(200, { files: makeTrashed(30, "brk"), nextPageToken: "tok2" });
    });

    const result = await getTrashedFiles("tok", "trashed=true", controller.signal);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(30);
  });
});

// Regression: getDriveStorageQuota (sidebar storage quota display) must reuse
// driveFetch, parse int64 byte strings, tolerate an absent limit (unlimited),
// and NEVER throw — the sidebar hides itself on failure.
describe("getDriveStorageQuota", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches about?fields=storageQuota and parses string byte fields", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(200, {
        storageQuota: {
          limit: "16106127360",
          usage: "2576980377",
          usageInDrive: "2500000000",
          usageInDriveTrash: "100000000",
        },
      })
    );

    const quota = await getDriveStorageQuota("tok-1");

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockedFetch.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/drive/v3/about?fields=storageQuota");
    expect((opts?.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(quota).toEqual({
      limit: 16106127360,
      usage: 2576980377,
      usageInDrive: 2500000000,
      usageInDriveTrash: 100000000,
    });
  });

  it("keeps already-numeric fields and returns limit null when absent (unlimited)", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(200, {
        storageQuota: { usage: 123456789, usageInDrive: 100000000, usageInDriveTrash: 0 },
      })
    );

    const quota = await getDriveStorageQuota("tok-1");

    expect(quota).toEqual({
      limit: null,
      usage: 123456789,
      usageInDrive: 100000000,
      usageInDriveTrash: 0,
    });
  });

  it("returns null + warn captureError on a non-ok response (no retry on 4xx)", async () => {
    mockedFetch.mockResolvedValueOnce(makeResponse(401));

    const quota = await getDriveStorageQuota("tok-1");

    expect(quota).toBeNull();
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "driveApi" })
    );
  });

  it("returns null + warn captureError on network failure after retries (never throws)", async () => {
    vi.useFakeTimers();
    mockedFetch.mockRejectedValue(new Error("network down"));

    const p = getDriveStorageQuota("tok-1");
    await vi.advanceTimersByTimeAsync(64_000);
    const quota = await p;

    expect(quota).toBeNull();
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "driveApi" })
    );
  });

  it("returns null when storageQuota is missing or a mandatory usage field is absent", async () => {
    mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, { kind: "drive#about" }));
    expect(await getDriveStorageQuota("tok-1")).toBeNull();

    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(200, { storageQuota: { usage: "10", usageInDrive: "5" } })
    );
    expect(await getDriveStorageQuota("tok-1")).toBeNull();
  });

  it("treats a non-numeric limit as absent (null) while keeping numeric usage", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(200, {
        storageQuota: {
          limit: "not-a-number",
          usage: "100",
          usageInDrive: "50",
          usageInDriveTrash: "1",
        },
      })
    );

    const quota = await getDriveStorageQuota("tok-1");

    expect(quota).toEqual({ limit: null, usage: 100, usageInDrive: 50, usageInDriveTrash: 1 });
  });
});

// Resumable upload: POST initiate (via driveFetch) → Location → PUT bytes (via
// fetchWithAuth, no auto-retry). Transient PUT failures re-initiate a NEW
// session at most once; caller aborts and HTTP errors never retry.
describe("uploadFileResumable", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });

  // Mirrors UPLOAD_TIMEOUT_MS in driveApi.ts (not exported): the PUT step must
  // override fetchWithAuth's 15s default with this 120s upload bound, or a
  // slow upload dies to the internal timeout before the resumable limit.
  const PUT_TIMEOUT_MS = 120_000;

  const INITIATE_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
  const LOCATION =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test-123";
  const uploadedFile: DriveFileItem = {
    id: "file-1",
    name: "song.mp3",
    mimeType: "audio/mpeg",
  };

  function makeLocationResponse(status: number, location: string): Response {
    const ok = status >= 200 && status < 300;
    return {
      status,
      ok,
      headers: {
        get: (name: string) => (String(name).toLowerCase() === "location" ? location : null),
      },
      json: async () => ({}),
    } as unknown as Response;
  }

  function makeErrorBodyResponse(status: number, message: string, reason?: string): Response {
    return makeJsonResponse(status, {
      error: { code: status, message, reason: reason ?? "badRequest" },
    });
  }

  it("happy path: POST initiate 200 + Location, PUT 201 + body → returns DriveFileItem", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const blob = new Blob([new Uint8Array(10)]);
    const result = await uploadFileResumable("tok", blob, "song.mp3", "parent-1");

    expect(result).toEqual(uploadedFile);
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    const [postUrl, postOpts] = mockedFetch.mock.calls[0];
    expect(postUrl).toBe(INITIATE_URL);
    expect(postOpts?.method).toBe("POST");
    const postHeaders = postOpts?.headers as Record<string, string>;
    expect(postHeaders["Authorization"]).toBe("Bearer tok");
    expect(postHeaders["Content-Type"]).toBe("application/json; charset=UTF-8");
    expect(postHeaders["X-Upload-Content-Type"]).toBe("application/octet-stream");
    expect(postHeaders["X-Upload-Content-Length"]).toBe("10");
    expect(JSON.parse(String(postOpts?.body))).toEqual({ name: "song.mp3", parents: ["parent-1"] });

    const [putUrl, putOpts] = mockedFetch.mock.calls[1];
    expect(putUrl).toBe(LOCATION);
    expect(putOpts?.method).toBe("PUT");
    const putHeaders = putOpts?.headers as Record<string, string>;
    expect(putHeaders["Content-Range"]).toBe("bytes 0-9/10");
    expect(putHeaders["Content-Type"]).toBe("application/octet-stream");
    expect(putOpts?.timeoutMs).toBe(PUT_TIMEOUT_MS);
  });

  it("POST initiate 404 → UploadError kind invalid, no retry", async () => {
    mockedFetch.mockResolvedValueOnce(makeErrorBodyResponse(404, "File not found"));

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
    ).rejects.toMatchObject({ name: "UploadError", kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("POST initiate 403 with quota message → UploadError kind quota", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeErrorBodyResponse(
        403,
        "The user's Drive storage quota has been exceeded.",
        "storageQuotaExceeded"
      )
    );

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
    ).rejects.toMatchObject({ kind: "quota" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("PUT 401 → UploadError kind auth, no retry", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeErrorBodyResponse(401, "Unauthorized"));

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
    ).rejects.toMatchObject({ kind: "auth" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("PUT network error on first attempt → re-initiates a new session and succeeds", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const result = await uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p");

    expect(result).toEqual(uploadedFile);
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(mockedFetch.mock.calls[0][0]).toBe(INITIATE_URL);
    expect(mockedFetch.mock.calls[1][0]).toBe(LOCATION);
    expect(mockedFetch.mock.calls[2][0]).toBe(INITIATE_URL);
    expect(mockedFetch.mock.calls[3][0]).toBe(LOCATION);
    // Both PUT attempts (call 1 and call 3) must carry the upload timeout.
    expect(mockedFetch.mock.calls[1][1]?.timeoutMs).toBe(PUT_TIMEOUT_MS);
    expect(mockedFetch.mock.calls[3][1]?.timeoutMs).toBe(PUT_TIMEOUT_MS);
  });

  it("PUT network error on both attempts → UploadError kind network", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockRejectedValueOnce(new Error("network down"));

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
    ).rejects.toMatchObject({ kind: "network" });
    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it("caller abort before upload → UploadError kind aborted, zero network calls", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p", controller.signal)
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("caller abort mid-upload → UploadError kind aborted, no retry", async () => {
    const controller = new AbortController();
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      });

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p", controller.signal)
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("POST initiate 200 without Location header → UploadError kind invalid", async () => {
    mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, {}));

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("Uint8Array input: exact byte length in X-Upload-Content-Length and Content-Range", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    await uploadFileResumable("tok", new Uint8Array([1, 2, 3, 4, 5]), "a.mp3", "p");

    const postHeaders = mockedFetch.mock.calls[0][1]?.headers as Record<string, string>;
    const putHeaders = mockedFetch.mock.calls[1][1]?.headers as Record<string, string>;
    expect(postHeaders["X-Upload-Content-Length"]).toBe("5");
    expect(putHeaders["Content-Range"]).toBe("bytes 0-4/5");
  });

  it("0-byte file → UploadError kind invalid (Google docs do not define Content-Range for empty files)", async () => {
    await expect(uploadFileResumable("tok", new Blob([]), "empty.mp3", "p")).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(
      uploadFileResumable("tok", new Uint8Array(0), "empty.mp3", "p")
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("PUT 200 (not only 201) is treated as success", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(200, uploadedFile));

    const result = await uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p");

    expect(result).toEqual(uploadedFile);
  });

  it("PUT 403 with quota message → UploadError kind quota", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeErrorBodyResponse(
          403,
          "The user's Drive storage quota has been exceeded.",
          "storageQuotaExceeded"
        )
      );

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
    ).rejects.toMatchObject({ kind: "quota" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  // Upload diagnostics: the concrete 4xx status + sanitized reason must reach
  // the error log — uploadManager only records the kind, so without this a
  // real 400/404/403 disappears from the log and the root cause is invisible.
  describe("upload 4xx diagnostics (captureError in mapUploadHttpError)", () => {
    function lastLogMessages(): string {
      return vi.mocked(captureError).mock.calls.map((c) => c[0].message).join("\n");
    }

    it("logs warn captureError with status=404 + errBody message before throwing", async () => {
      mockedFetch.mockResolvedValueOnce(makeErrorBodyResponse(404, "File not found"));

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
      ).rejects.toMatchObject({ name: "UploadError", kind: "invalid" });

      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "driveApi",
          message: expect.stringContaining("status=404"),
        })
      );
      expect(lastLogMessages()).toContain("File not found");
    });

    it("logs status=403 for a quota 403 (kind mapping unchanged)", async () => {
      mockedFetch.mockResolvedValueOnce(
        makeErrorBodyResponse(403, "The user's Drive storage quota has been exceeded.", "storageQuotaExceeded")
      );

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
      ).rejects.toMatchObject({ kind: "quota" });

      expect(lastLogMessages()).toContain("status=403");
      expect(lastLogMessages()).toContain("storageQuotaExceeded");
    });

    it("logs status=400 for a generic 4xx", async () => {
      mockedFetch.mockResolvedValueOnce(makeErrorBodyResponse(400, "Bad Request"));

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).toContain("status=400");
    });

    it("logs only the status when the error body carries no message/reason", async () => {
      mockedFetch.mockResolvedValueOnce(makeResponse(404));

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).toBe("upload-http-error (status=404)");
    });

    it("never logs the auth token", async () => {
      mockedFetch.mockResolvedValueOnce(makeErrorBodyResponse(400, "Bad Request"));

      await expect(
        uploadFileResumable("super-secret-token-42", new Uint8Array(3), "a.mp3", "p")
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).not.toContain("super-secret-token-42");
    });

    it("redacts embedded id= values from the errBody message (sanitized)", async () => {
      mockedFetch.mockResolvedValueOnce(makeErrorBodyResponse(400, "file id=abc123 locked"));

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).not.toContain("abc123");
      expect(lastLogMessages()).toContain("[REDACTED_ID]");
    });

    it("caps a very long errBody message instead of bloating the log", async () => {
      const longMessage = "x".repeat(500);
      mockedFetch.mockResolvedValueOnce(makeErrorBodyResponse(400, longMessage));

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p")
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).not.toContain(longMessage);
      expect(lastLogMessages().length).toBeLessThanOrEqual(300);
    });
  });
});

// Chunked streaming resumable upload: POST initiate → loop { PUT chunk →
// 308 Range resume | 200/201 done | 404 restart session }. Memory stays
// bounded at chunk size regardless of file size (the upload spike fix).
describe("uploadFileResumableChunked", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const INITIATE_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
  const LOCATION =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=chunk-123";
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB
  const TOTAL_SIZE = 10_000_000;
  // Mirrors UPLOAD_TIMEOUT_MS in driveApi.ts: each chunk PUT overrides
  // fetchWithAuth's 15s default with the 120s upload bound.
  const PUT_TIMEOUT_MS = 120_000;
  const uploadedFile: DriveFileItem = {
    id: "file-9",
    name: "big.flac",
    mimeType: "audio/flac",
  };

  function makeLocationResponse(status: number, location: string): Response {
    const ok = status >= 200 && status < 300;
    return {
      status,
      ok,
      headers: {
        get: (name: string) => (String(name).toLowerCase() === "location" ? location : null),
      },
      json: async () => ({}),
    } as unknown as Response;
  }

  function makeRangeResponse(status: number, range: string | null): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => (String(name).toLowerCase() === "range" ? range : null) },
      json: async () => ({}),
    } as unknown as Response;
  }

  function makeErrorBodyResponse(status: number, message: string, reason?: string): Response {
    return makeJsonResponse(status, {
      error: { code: status, message, reason: reason ?? "badRequest" },
    });
  }

  // Offset-capable reader mirroring uploadManager's readChunk contract:
  // returns the slice at `offset`, null when past the end.
  function makeReader(bytes: Uint8Array, chunkSize: number): {
    readChunk: (offset: number) => Promise<Uint8Array | null>;
    offsets: number[];
  } {
    const offsets: number[] = [];
    return {
      offsets,
      readChunk: async (offset) => {
        offsets.push(offset);
        if (offset >= bytes.length) return null;
        return bytes.slice(offset, offset + chunkSize);
      },
    };
  }

  function makePayload(size: number, fill = 7): Uint8Array {
    const b = new Uint8Array(size);
    b.fill(fill);
    return b;
  }

  it("happy path: 2 chunks via 308 resume, Content-Range exact, progress fractions", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-8388607"))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const reader = makeReader(makePayload(TOTAL_SIZE), CHUNK_SIZE);
    const fractions: number[] = [];
    const result = await uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: TOTAL_SIZE,
      readChunk: reader.readChunk,
      onProgress: (f) => fractions.push(f),
    });

    expect(result).toEqual(uploadedFile);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(reader.offsets).toEqual([0, CHUNK_SIZE]);

    const [postUrl, postOpts] = mockedFetch.mock.calls[0];
    expect(postUrl).toBe(INITIATE_URL);
    expect(postOpts?.method).toBe("POST");
    expect((postOpts?.headers as Record<string, string>)["X-Upload-Content-Length"]).toBe(String(TOTAL_SIZE));

    const [put1Url, put1Opts] = mockedFetch.mock.calls[1];
    expect(put1Url).toBe(LOCATION);
    expect(put1Opts?.method).toBe("PUT");
    const put1Headers = put1Opts?.headers as Record<string, string>;
    expect(put1Headers["Content-Range"]).toBe("bytes 0-8388607/10000000");
    expect(put1Opts?.timeoutMs).toBe(PUT_TIMEOUT_MS);

    const [, put2Opts] = mockedFetch.mock.calls[2];
    const put2Headers = put2Opts?.headers as Record<string, string>;
    expect(put2Headers["Content-Range"]).toBe("bytes 8388608-9999999/10000000");

    expect(fractions).toEqual([8388608 / 10000000, 1]);
  });

  it("308 Range mid-chunk → resumes at lastByte+1 (readChunk called with the new offset)", async () => {
    const total = 20_000_000; // 3 full chunks + 1 tail, room for a mid-chunk resume
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-4194303"))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-8388607"))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-16777215"))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const reader = makeReader(makePayload(total), CHUNK_SIZE);
    await uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: total,
      readChunk: reader.readChunk,
    });

    expect(reader.offsets).toEqual([0, 4194304, 8388608, 16777216]);
    const [, put2Opts] = mockedFetch.mock.calls[2];
    expect((put2Opts?.headers as Record<string, string>)["Content-Range"]).toBe("bytes 4194304-12582911/20000000");
    const [, put3Opts] = mockedFetch.mock.calls[3];
    expect((put3Opts?.headers as Record<string, string>)["Content-Range"]).toBe("bytes 8388608-16777215/20000000");
    const [, put4Opts] = mockedFetch.mock.calls[4];
    expect((put4Opts?.headers as Record<string, string>)["Content-Range"]).toBe("bytes 16777216-19999999/20000000");
  });

  it("308 without a Range header → offset resets to 0, chunk resent from the start", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, null))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const data = makePayload(CHUNK_SIZE);
    const reader = makeReader(data, CHUNK_SIZE);
    await uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: CHUNK_SIZE,
      readChunk: reader.readChunk,
    });

    expect(reader.offsets).toEqual([0, 0]);
    const [, put1Opts] = mockedFetch.mock.calls[1];
    const [, put2Opts] = mockedFetch.mock.calls[2];
    expect((put1Opts?.headers as Record<string, string>)["Content-Range"]).toBe("bytes 0-8388607/8388608");
    expect((put2Opts?.headers as Record<string, string>)["Content-Range"]).toBe("bytes 0-8388607/8388608");
  });

  it("chunk 500 → retried twice with backoff [1s, 3s], then network UploadError", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(500, null))
      .mockResolvedValueOnce(makeRangeResponse(500, null))
      .mockResolvedValueOnce(makeRangeResponse(500, null));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    const p = uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: CHUNK_SIZE,
      readChunk: reader.readChunk,
    });
    const assertion = expect(p).rejects.toMatchObject({ kind: "network" });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    // 1 original PUT + 2 retries = 3 PUT calls, no session restart.
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(reader.offsets).toEqual([0]);
  });

  it("chunk 429 → retried, succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(429, null))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    const p = uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: CHUNK_SIZE,
      readChunk: reader.readChunk,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toEqual(uploadedFile);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("404 on a chunk PUT → restarts a whole new session (POST + PUT again), succeeds", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(404, null))
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    const result = await uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: CHUNK_SIZE,
      readChunk: reader.readChunk,
    });

    expect(result).toEqual(uploadedFile);
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(mockedFetch.mock.calls[0][0]).toBe(INITIATE_URL);
    expect(mockedFetch.mock.calls[1][0]).toBe(LOCATION);
    expect(mockedFetch.mock.calls[2][0]).toBe(INITIATE_URL);
    expect(mockedFetch.mock.calls[3][0]).toBe(LOCATION);
    // A fresh session re-uploads from offset 0.
    expect(reader.offsets).toEqual([0, 0]);
  });

  it("404 twice → network UploadError after 2 session attempts", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(404, null))
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(404, null));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      })
    ).rejects.toMatchObject({ kind: "network" });
    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it("caller abort mid-upload → aborted, no chunk retry, no session restart", async () => {
    const controller = new AbortController();
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      });

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("caller abort before upload → aborted, zero network calls", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: async () => makePayload(10),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("totalSize 0 → invalid, no network calls", async () => {
    await expect(
      uploadFileResumableChunked("tok", {
        name: "empty.flac",
        parentId: "p",
        totalSize: 0,
        readChunk: async () => null,
      })
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("PUT 403 quota → quota, no session restart", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeErrorBodyResponse(
          403,
          "The user's Drive storage quota has been exceeded.",
          "storageQuotaExceeded"
        )
      );

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      })
    ).rejects.toMatchObject({ kind: "quota" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("PUT 401 → auth, no session restart", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeErrorBodyResponse(401, "Unauthorized"));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      })
    ).rejects.toMatchObject({ kind: "auth" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("readChunk returns null before totalSize (EOF early) → invalid", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-4"));

    const data = makePayload(5);
    const reader = makeReader(data, CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: TOTAL_SIZE,
        readChunk: reader.readChunk,
      })
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(reader.offsets).toEqual([0, 5]);
  });

  it("readChunk rejects → invalid UploadError, no retry", async () => {
    mockedFetch.mockResolvedValueOnce(makeLocationResponse(200, LOCATION));

    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: async () => {
          throw new Error("disk io error");
        },
      })
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("chunk overshoot (readChunk beyond totalSize) → invalid, no PUT", async () => {
    mockedFetch.mockResolvedValueOnce(makeLocationResponse(200, LOCATION));

    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: 10,
        readChunk: async () => makePayload(CHUNK_SIZE),
      })
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("308 Range covering the whole file → invalid (server anomaly, would re-send out of range)", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, `bytes=0-${TOTAL_SIZE - 1}`));

    const reader = makeReader(makePayload(TOTAL_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: TOTAL_SIZE,
        readChunk: reader.readChunk,
      })
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("logs warn captureError with status=400 when a chunk PUT hits a non-retryable 4xx", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeErrorBodyResponse(400, "Invalid upload request"));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      })
    ).rejects.toMatchObject({ kind: "invalid" });

    const message = vi.mocked(captureError).mock.calls.map((c) => c[0].message).join("\n");
    expect(message).toContain("status=400");
    expect(message).toContain("Invalid upload request");
  });
});
