import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  backoffDelay,
  driveFetch,
  searchFolders,
  listFolderChildren,
  getTrashedFiles,
  getDriveStorageQuota,
  uploadFileResumable,
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
});
