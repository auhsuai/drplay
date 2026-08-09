import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  backoffDelay,
  createFolder,
  driveFetch,
  getDriveStorageQuota,
  getRecentlyAddedAudioFiles,
  saveAppConfig,
  shouldRetryDriveResponse,
  withSaveConfigLock,
  type DriveFolderItem,
  type DriveFileItem,
} from "./driveApi";
import {
  searchFolders,
  listFolderChildren,
  getTrashedFiles,
} from "./drivePagination";
import {
  uploadFileResumable,
  uploadFileResumableChunked,
  generateClientId,
} from "./driveUpload";

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

function fetchCallAt(index: number): (typeof mockedFetch.mock.calls)[number] {
  const call = mockedFetch.mock.calls[index];
  if (call === undefined)
    throw new Error(`expected fetch call ${String(index)}`);
  return call;
}

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
    json: () => body,
  } as unknown as Response;
}

// Drive error response with a cloneable body, mirroring the real API: 403
// rate-limit detection reads the body via response.clone() so the original
// response stays usable.
// Shape is the REAL Google Drive error format — the reason lives inside
// error.errors[] (developers.google.com/workspace/drive/api/guides/handle-errors),
// not at error.reason. The chunked-upload tests share this helper, so the
// shape change exercises driveApi.isRateLimitError through the shared
// isRateLimit403Response for both the retry and the upload paths.
function makeRateLimitResponse(status: number, reason: string): Response {
  const ok = status >= 200 && status < 300;
  const body = {
    error: {
      code: status,
      message: "Rate Limit Exceeded",
      errors: [{ reason }],
    },
  };
  const response = {
    status,
    ok,
    headers: { get: () => null },
    json: () => body,
    clone: () => response,
  } as unknown as Response;
  return response;
}

// Legacy shape used by some older clients: top-level error.reason. Still
// supported for backward compatibility (no regression on the old contract).
function makeLegacyRateLimitResponse(status: number, reason: string): Response {
  const ok = status >= 200 && status < 300;
  const body = {
    error: { code: status, message: "Rate Limit Exceeded", reason },
  };
  const response = {
    status,
    ok,
    headers: { get: () => null },
    json: () => body,
    clone: () => response,
  } as unknown as Response;
  return response;
}

// AbortSignal.reason is `any`; normalize it to a real Error so the mock's
// Promise rejection reasons stay Error-typed (like the real abort flow).
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("aborted", "AbortError");
}

describe("getRecentlyAddedAudioFiles", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requests a full page (pageSize=100) of the newest audio files with audio fields preserved", async () => {
    mockedFetch.mockResolvedValue(makeJsonResponse(200, { files: [] }));
    await getRecentlyAddedAudioFiles("tok-test");

    const firstCall = fetchCallAt(0);
    const url = firstCall[0] as string;
    expect(url).toContain("pageSize=100");
    expect(url).toContain("orderBy=createdTime desc");
    expect(url).toContain("fields=files(id,name,mimeType,size,modifiedTime)");
    expect(url).toContain("q=");
  });

  it("maps the Drive response files array into the returned list", async () => {
    mockedFetch.mockResolvedValue(
      makeJsonResponse(200, {
        files: [{ id: "x", name: "A.mp3", mimeType: "audio/mpeg" }],
      }),
    );
    const items = await getRecentlyAddedAudioFiles("tok-test");
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("x");
  });
});

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

// Shared retryable-status check for the THREE Drive retry loops (driveFetch,
// queryResumableStatus, putChunkWithRetry): 429/5xx by status alone, 403 only
// when the body reports a Drive rate-limit reason (read via clone, only while
// retries remain so the final attempt never consumes the body).
describe("shouldRetryDriveResponse", () => {
  it("returns true for 429 and 5xx statuses", async () => {
    expect(await shouldRetryDriveResponse(makeResponse(429), 0, 2)).toBe(true);
    expect(await shouldRetryDriveResponse(makeResponse(500), 0, 2)).toBe(true);
    expect(await shouldRetryDriveResponse(makeResponse(503), 0, 2)).toBe(true);
  });

  it("returns false for 2xx and non-retryable 4xx", async () => {
    expect(await shouldRetryDriveResponse(makeResponse(200), 0, 2)).toBe(false);
    expect(await shouldRetryDriveResponse(makeResponse(400), 0, 2)).toBe(false);
    expect(await shouldRetryDriveResponse(makeResponse(404), 0, 2)).toBe(false);
  });

  it("returns true for a 403 rate-limit body (rateLimitExceeded) while retries remain", async () => {
    expect(
      await shouldRetryDriveResponse(
        makeRateLimitResponse(403, "rateLimitExceeded"),
        0,
        2,
      ),
    ).toBe(true);
  });

  it("returns false for a 403 with a non-rate-limit reason (permission error)", async () => {
    expect(
      await shouldRetryDriveResponse(
        makeRateLimitResponse(403, "insufficientFilePermissions"),
        0,
        2,
      ),
    ).toBe(false);
  });

  it("never reads the 403 body on the final attempt (attempt >= maxRetries)", async () => {
    const clone = vi.fn(() => {
      throw new TypeError("body already used");
    });
    const response = {
      status: 403,
      ok: false,
      headers: { get: () => null },
      clone,
    } as unknown as Response;
    expect(await shouldRetryDriveResponse(response, 2, 2)).toBe(false);
    expect(clone).not.toHaveBeenCalled();
  });

  it("still reports 429 retryable on the final attempt — the caller decides exhausted behavior", async () => {
    expect(await shouldRetryDriveResponse(makeResponse(429), 2, 2)).toBe(true);
  });

  it("honors a caller-supplied status predicate (driveFetch's narrower whitelist)", async () => {
    const driveFetchWhitelist = (status: number): boolean =>
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504;
    // 501 is retryable under the upload loops' 5xx range formula but NOT under
    // driveFetch's historical whitelist — the predicate must preserve both.
    expect(
      await shouldRetryDriveResponse(
        makeResponse(501),
        0,
        4,
        driveFetchWhitelist,
      ),
    ).toBe(false);
    expect(await shouldRetryDriveResponse(makeResponse(501), 0, 4)).toBe(true);
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

  it("retries a 403 rate-limit (rateLimitExceeded) and returns the eventual 200", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeRateLimitResponse(403, "rateLimitExceeded"))
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("retries a 403 rate-limit (userRateLimitExceeded) and returns the eventual 200", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        makeRateLimitResponse(403, "userRateLimitExceeded"),
      )
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("still retries a 403 whose body uses the legacy top-level error.reason (no regression)", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        makeLegacyRateLimitResponse(403, "rateLimitExceeded"),
      )
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("does NOT retry a 403 with a non-rate-limit reason (permission error)", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeRateLimitResponse(403, "insufficientFilePermissions"),
    );

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(403);
  });

  it("does NOT retry a 403 when the body clone throws (body already consumed)", async () => {
    const consumed: Response = {
      status: 403,
      ok: false,
      headers: { get: () => null },
      clone: () => {
        throw new TypeError(
          "Failed to execute 'clone' on 'Response': body is already used",
        );
      },
    } as unknown as Response;
    mockedFetch.mockResolvedValueOnce(consumed);

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    await vi.advanceTimersByTimeAsync(64_000);
    const res = await p;

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(403);
  });

  it("honors Retry-After: 5 on a 503 → waits a full 5s before the retry", async () => {
    const retryAfterResponse = {
      status: 503,
      ok: false,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? "5" : null,
      },
      json: () => ({}),
    } as unknown as Response;
    mockedFetch
      .mockResolvedValueOnce(retryAfterResponse)
      .mockResolvedValueOnce(makeResponse(200));

    const p = driveFetch("https://www.googleapis.com/drive/v3/files");
    // backoffDelay(0, "5") is deterministic (no jitter): 5000ms. At t=4000 the
    // retry must NOT have fired yet — only the original call.
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;
    expect(res.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

// Regression: driveFetch must forward its timeoutMs into fetchWithAuth so the
// declared 20s default (and any caller override) actually applies. The old
// code merged only `signal`, so fetchWithAuth's internal 15s default always
// won and the driveApi timeout was dead on arrival.
describe("driveFetch forwards timeoutMs to fetchWithAuth", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the default 20s timeoutMs when the caller passes none", async () => {
    mockedFetch.mockResolvedValueOnce(makeResponse(200));

    const res = await driveFetch("https://www.googleapis.com/drive/v3/files");

    expect(res.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const firstCall = fetchCallAt(0);
    const opts = firstCall[1] as RequestInit & {
      timeoutMs?: number;
    };
    expect(opts.timeoutMs).toBe(20000);
  });

  it("forwards an explicit caller timeoutMs override", async () => {
    mockedFetch.mockResolvedValueOnce(makeResponse(200));

    const res = await driveFetch(
      "https://www.googleapis.com/drive/v3/files",
      {},
      5000,
    );

    expect(res.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const firstCall = fetchCallAt(0);
    const opts = firstCall[1] as RequestInit & {
      timeoutMs?: number;
    };
    expect(opts.timeoutMs).toBe(5000);
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
      setTimeout(() => {
        controller.abort(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        );
      }, ms);
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
            reject(abortReason(signal));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(abortReason(signal));
          });
        }),
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

// Regression: createFolder must forward a caller signal into driveFetch so a
// cancel of an in-flight folder upload aborts the Drive request (Bug 1d).
describe("createFolder abort propagation (Bug 1d)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("forwards the caller signal into driveFetch", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(200, {
        id: "folder-1",
        name: "Album",
        mimeType: "application/vnd.google-apps.folder",
      }),
    );
    const controller = new AbortController();

    const result = await createFolder(
      "tok",
      "Album",
      "root",
      controller.signal,
    );

    expect(result.id).toBe("folder-1");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const firstCall = fetchCallAt(0);
    const [url, opts] = firstCall;
    expect(url).toBe("https://www.googleapis.com/drive/v3/files");
    expect((opts as RequestInit | undefined)?.signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("rejects without retrying when the caller aborts mid-flight", async () => {
    const controller = new AbortController();
    mockedFetch.mockImplementation(
      (_url: RequestInfo | URL, opts?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          if (!signal) {
            // Pre-fix the caller signal was never forwarded — fail loudly so
            // the regression test is RED before the implementation exists.
            reject(new Error("caller signal was not forwarded"));
            return;
          }
          if (signal.aborted) {
            reject(abortReason(signal));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(abortReason(signal));
            },
            { once: true },
          );
        }),
    );

    const p = createFolder("tok", "Album", "root", controller.signal);
    const assertion = expect(p).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(200_000);

    await assertion;
    // User abort must not schedule retries (same contract as driveFetch 1b).
    expect(mockedFetch).toHaveBeenCalledTimes(1);
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
    Array.from({ length: count }, (_, i) =>
      folder(`${prefix}${String(i)}`, `${prefix}${String(i)}`),
    );

  const captureUrls = (
    pages: Array<{ files: DriveFolderItem[]; nextPageToken?: string }>,
  ): string[] => {
    const urls: string[] = [];
    mockedFetch.mockImplementation((input: RequestInfo | URL) => {
      urls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const page = pages[urls.length - 1];
      return Promise.resolve(makeJsonResponse(200, page));
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

  // Behavior contract for the generic paginator: the folder path must keep
  // orderBy=name and pageSize bound exactly as before the deduplication.
  it("searchFolders keeps orderBy=name and pageSize in the request URL", async () => {
    const urls = captureUrls([{ files: makeFiles(2, "z") }]);

    await searchFolders("tok", "name contains 'foo'");

    expect(urls[0]).toContain("orderBy=name");
    expect(urls[0]).toContain("pageSize=1000");
  });

  // Error format is part of the public contract (callers surface it in the UI);
  // a 404 (non-retryable) must reject with the exact label + status.
  it("searchFolders throws `Failed to search folders (status)` on a non-ok response", async () => {
    mockedFetch.mockResolvedValueOnce(makeResponse(404));

    await expect(searchFolders("tok", "name contains 'foo'")).rejects.toThrow(
      "Failed to search folders (404)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
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
    mockedFetch.mockImplementation(() => {
      if (!controller.signal.aborted) controller.abort();
      return Promise.resolve(
        makeJsonResponse(200, {
          files: makeFiles(30, "brk"),
          nextPageToken: "tok2",
        }),
      );
    });

    const result = await searchFolders(
      "tok",
      "name contains 'foo'",
      controller.signal,
    );

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
    Array.from({ length: count }, (_, i) =>
      trashed(`${prefix}${String(i)}`, `${prefix}${String(i)}`),
    );

  const captureTrashedUrls = (
    pages: Array<{ files: DriveFileItem[]; nextPageToken?: string }>,
  ): string[] => {
    const urls: string[] = [];
    mockedFetch.mockImplementation((input: RequestInfo | URL) => {
      urls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const page = pages[urls.length - 1];
      return Promise.resolve(makeJsonResponse(200, page));
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

  // Behavior contract: the trash screen sorts folders before files via
  // orderBy=folder,name. A generic paginator defaulting to orderBy=name would
  // silently change the displayed order — the trash path must keep it.
  it("keeps orderBy=folder,name so folders sort before files in the trash screen", async () => {
    const urls = captureTrashedUrls([{ files: makeTrashed(2, "z") }]);

    await getTrashedFiles("tok", "trashed=true");

    expect(urls[0]).toContain("orderBy=folder,name");
  });

  // Error format is part of the public contract; a 404 must reject with the
  // exact same message the single-loop implementation produced.
  it("throws `Failed to fetch trashed files (status)` on a non-ok response", async () => {
    mockedFetch.mockResolvedValueOnce(makeResponse(404));

    await expect(getTrashedFiles("tok", "trashed=true")).rejects.toThrow(
      "Failed to fetch trashed files (404)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
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
    mockedFetch.mockImplementation(() => {
      if (!controller.signal.aborted) controller.abort();
      return Promise.resolve(
        makeJsonResponse(200, {
          files: makeTrashed(30, "brk"),
          nextPageToken: "tok2",
        }),
      );
    });

    const result = await getTrashedFiles(
      "tok",
      "trashed=true",
      controller.signal,
    );

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(30);
  });
});

// Upgrade: a 200 response whose body is not valid JSON (proxy truncation,
// wrong Content-Type, server bug) must reject with a classified error instead
// of a raw SyntaxError leaking out of response.json() — callers surface the
// message in the UI, so "malformed response" tells the user the server answer
// was unreadable rather than dumping a parser error.
describe("drivePagination malformed JSON body", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("searchFolders throws `Failed to search folders (malformed response)` when json() rejects", async () => {
    mockedFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: () => {
        throw new SyntaxError(
          "Unexpected token '<', \"<html>...\" is not valid JSON",
        );
      },
    } as unknown as Response);

    await expect(searchFolders("tok", "name contains 'foo'")).rejects.toThrow(
      "Failed to search folders (malformed response)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
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
      }),
    );

    const quota = await getDriveStorageQuota("tok-1");

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const firstCall = fetchCallAt(0);
    const [url, opts] = firstCall;
    expect(url).toBe(
      "https://www.googleapis.com/drive/v3/about?fields=storageQuota",
    );
    expect((opts?.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-1",
    );
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
        storageQuota: {
          usage: 123456789,
          usageInDrive: 100000000,
          usageInDriveTrash: 0,
        },
      }),
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
      expect.objectContaining({ level: "warn", source: "driveApi" }),
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
      expect.objectContaining({ level: "warn", source: "driveApi" }),
    );
  });

  it("returns null when storageQuota is missing or a mandatory usage field is absent", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(200, { kind: "drive#about" }),
    );
    expect(await getDriveStorageQuota("tok-1")).toBeNull();

    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(200, {
        storageQuota: { usage: "10", usageInDrive: "5" },
      }),
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
      }),
    );

    const quota = await getDriveStorageQuota("tok-1");

    expect(quota).toEqual({
      limit: null,
      usage: 100,
      usageInDrive: 50,
      usageInDriveTrash: 1,
    });
  });
});

// Resumable upload: POST initiate (via driveFetch) → Location → PUT bytes (via
// fetchWithAuth, no auto-retry). Exactly ONE attempt: transient network/timeout
// failures wrap into UploadError('network') for the manager's single retry
// layer (uploadWithRetry); caller aborts and HTTP errors never retry.
describe("uploadFileResumable", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });

  // Mirrors UPLOAD_TIMEOUT_MS in driveApi.ts (not exported): the PUT step must
  // override fetchWithAuth's 15s default with this 120s upload bound, or a
  // slow upload dies to the internal timeout before the resumable limit.
  const PUT_TIMEOUT_MS = 120_000;

  const INITIATE_URL =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
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
        get: (name: string) =>
          name.toLowerCase() === "location" ? location : null,
      },
      json: () => ({}),
    } as unknown as Response;
  }

  function makeErrorBodyResponse(
    status: number,
    message: string,
    reason?: string,
  ): Response {
    return makeJsonResponse(status, {
      error: { code: status, message, reason: reason ?? "badRequest" },
    });
  }

  it("happy path: POST initiate 200 + Location, PUT 201 + body → returns DriveFileItem", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const blob = new Blob([new Uint8Array(10)]);
    const result = await uploadFileResumable(
      "tok",
      blob,
      "song.mp3",
      "parent-1",
    );

    expect(result).toEqual(uploadedFile);
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    const postCall = fetchCallAt(0);
    const [postUrl, postOpts] = postCall;
    expect(postUrl).toBe(INITIATE_URL);
    expect(postOpts?.method).toBe("POST");
    const postHeaders = postOpts?.headers as Record<string, string>;
    expect(postHeaders["Authorization"]).toBe("Bearer tok");
    expect(postHeaders["Content-Type"]).toBe("application/json; charset=UTF-8");
    expect(postHeaders["X-Upload-Content-Type"]).toBe(
      "application/octet-stream",
    );
    expect(postHeaders["X-Upload-Content-Length"]).toBe("10");
    expect(JSON.parse(postOpts?.body as string)).toEqual({
      name: "song.mp3",
      parents: ["parent-1"],
    });

    const putCall = fetchCallAt(1);
    const [putUrl, putOpts] = putCall;
    expect(putUrl).toBe(LOCATION);
    expect(putOpts?.method).toBe("PUT");
    const putHeaders = putOpts?.headers as Record<string, string>;
    expect(putHeaders["Content-Range"]).toBe("bytes 0-9/10");
    expect(putHeaders["Content-Type"]).toBe("application/octet-stream");
    expect(putOpts?.timeoutMs).toBe(PUT_TIMEOUT_MS);
  });

  it("POST initiate 404 → UploadError kind invalid, no retry", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeErrorBodyResponse(404, "File not found"),
    );

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
    ).rejects.toMatchObject({ name: "UploadError", kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("POST initiate 403 with quota message → UploadError kind quota", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeErrorBodyResponse(
        403,
        "The user's Drive storage quota has been exceeded.",
        "storageQuotaExceeded",
      ),
    );

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
    ).rejects.toMatchObject({ kind: "quota" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("PUT 401 → UploadError kind auth, no retry", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeErrorBodyResponse(401, "Unauthorized"));

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("PUT network error → UploadError kind network thrown immediately (single PUT, no re-initiate)", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
    ).rejects.toMatchObject({ kind: "network" });
    // Exactly one session: the leftover success mocks would have been consumed
    // by an internal retry — their non-use proves the retry loop is gone.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(fetchCallAt(0)[0]).toBe(INITIATE_URL);
    expect(fetchCallAt(1)[0]).toBe(LOCATION);
    expect(fetchCallAt(1)[1]?.timeoutMs).toBe(PUT_TIMEOUT_MS);
  });

  it("PUT timeout (merged 120s bound) → UploadError kind network, single attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        );
      }, ms);
      return controller.signal;
    });
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockImplementationOnce(
        (_url: RequestInfo | URL, opts?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = opts?.signal;
            if (!signal) {
              reject(new Error("no signal passed to PUT"));
              return;
            }
            signal.addEventListener("abort", () => {
              reject(abortReason(signal));
            });
          }),
      );

    const p = uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p");
    const assertion = expect(p).rejects.toMatchObject({ kind: "network" });
    await vi.advanceTimersByTimeAsync(130_000);

    await assertion;
    // A stalled PUT dies to the 120s bound exactly once — never a fresh session.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("caller abort before upload → UploadError kind aborted, zero network calls", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadFileResumable(
        "tok",
        new Uint8Array(3),
        "a.mp3",
        "p",
        controller.signal,
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("caller abort mid-upload → UploadError kind aborted, no retry", async () => {
    const controller = new AbortController();
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockImplementationOnce(() => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      });

    await expect(
      uploadFileResumable(
        "tok",
        new Uint8Array(3),
        "a.mp3",
        "p",
        controller.signal,
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("POST initiate 200 without Location header → UploadError kind invalid", async () => {
    mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, {}));

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("Uint8Array input: exact byte length in X-Upload-Content-Length and Content-Range", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    await uploadFileResumable(
      "tok",
      new Uint8Array([1, 2, 3, 4, 5]),
      "a.mp3",
      "p",
    );

    const firstCall = fetchCallAt(0);
    const secondCall = fetchCallAt(1);
    const postHeaders = firstCall[1]?.headers as Record<string, string>;
    const putHeaders = secondCall[1]?.headers as Record<string, string>;
    expect(postHeaders["X-Upload-Content-Length"]).toBe("5");
    expect(putHeaders["Content-Range"]).toBe("bytes 0-4/5");
  });

  it("0-byte file → UploadError kind invalid (Google docs do not define Content-Range for empty files)", async () => {
    await expect(
      uploadFileResumable("tok", new Blob([]), "empty.mp3", "p"),
    ).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(
      uploadFileResumable("tok", new Uint8Array(0), "empty.mp3", "p"),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("PUT 200 (not only 201) is treated as success", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(200, uploadedFile));

    const result = await uploadFileResumable(
      "tok",
      new Uint8Array(3),
      "a.mp3",
      "p",
    );

    expect(result).toEqual(uploadedFile);
  });

  it("PUT 403 with quota message → UploadError kind quota", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeErrorBodyResponse(
          403,
          "The user's Drive storage quota has been exceeded.",
          "storageQuotaExceeded",
        ),
      );

    await expect(
      uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
    ).rejects.toMatchObject({ kind: "quota" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  // Upload diagnostics: the concrete 4xx status + sanitized reason must reach
  // the error log — uploadManager only records the kind, so without this a
  // real 400/404/403 disappears from the log and the root cause is invisible.
  describe("upload 4xx diagnostics (captureError in mapUploadHttpError)", () => {
    function lastLogMessages(): string {
      return vi
        .mocked(captureError)
        .mock.calls.map((c) => c[0].message)
        .join("\n");
    }

    it("logs warn captureError with status=404 + errBody message before throwing", async () => {
      mockedFetch.mockResolvedValueOnce(
        makeErrorBodyResponse(404, "File not found"),
      );

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
      ).rejects.toMatchObject({ name: "UploadError", kind: "invalid" });

      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "driveApi",
          message: expect.stringContaining("status=404") as unknown as string,
        }),
      );
      expect(lastLogMessages()).toContain("File not found");
    });

    it("logs status=403 for a quota 403 (kind mapping unchanged)", async () => {
      mockedFetch.mockResolvedValueOnce(
        makeErrorBodyResponse(
          403,
          "The user's Drive storage quota has been exceeded.",
          "storageQuotaExceeded",
        ),
      );

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
      ).rejects.toMatchObject({ kind: "quota" });

      expect(lastLogMessages()).toContain("status=403");
      expect(lastLogMessages()).toContain("storageQuotaExceeded");
    });

    it("logs status=400 for a generic 4xx", async () => {
      mockedFetch.mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Bad Request"),
      );

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).toContain("status=400");
    });

    it("logs only the status when the error body carries no message/reason", async () => {
      mockedFetch.mockResolvedValueOnce(makeResponse(404));

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).toBe("upload-http-error (status=404)");
    });

    it("never logs the auth token", async () => {
      mockedFetch.mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Bad Request"),
      );

      await expect(
        uploadFileResumable(
          "super-secret-token-42",
          new Uint8Array(3),
          "a.mp3",
          "p",
        ),
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).not.toContain("super-secret-token-42");
    });

    it("redacts embedded id= values from the errBody message (sanitized)", async () => {
      mockedFetch.mockResolvedValueOnce(
        makeErrorBodyResponse(400, "file id=abc123 locked"),
      );

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).not.toContain("abc123");
      expect(lastLogMessages()).toContain("[REDACTED_ID]");
    });

    it("caps a very long errBody message instead of bloating the log", async () => {
      const longMessage = "x".repeat(500);
      mockedFetch.mockResolvedValueOnce(
        makeErrorBodyResponse(400, longMessage),
      );

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
      ).rejects.toMatchObject({ kind: "invalid" });

      expect(lastLogMessages()).not.toContain(longMessage);
      expect(lastLogMessages().length).toBeLessThanOrEqual(300);
    });
  });

  // Idempotent upload (Slice 1): a pre-generated file id bound into the
  // initiate metadata makes a retry after a response-lost success hit 409
  // instead of creating a duplicate — the retry then resolves DONE with the
  // real file (developers.google.com/workspace/drive/api/guides/manage-uploads,
  // "Use a pre-generated ID to upload files").
  describe("idempotent upload (clientGeneratedId)", () => {
    const existingFile: DriveFileItem = {
      id: "gen-1",
      name: "song.mp3",
      mimeType: "audio/mpeg",
      size: "10",
      modifiedTime: "2026-01-01T00:00:00Z",
    };

    it("initiate metadata body carries the pre-generated id", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      await uploadFileResumable(
        "tok",
        new Uint8Array(10),
        "song.mp3",
        "parent-1",
        undefined,
        { clientGeneratedId: "gen-1" },
      );

      const [postUrl, postOpts] = fetchCallAt(0);
      expect(postUrl).toBe(INITIATE_URL);
      expect(JSON.parse(postOpts?.body as string)).toEqual({
        name: "song.mp3",
        parents: ["parent-1"],
        id: "gen-1",
      });
    });

    it("PUT 409 + clientGeneratedId → resolves DONE with the real file (no duplicate, no error)", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(
          makeErrorBodyResponse(409, "A file with this ID already exists."),
        )
        .mockResolvedValueOnce(makeJsonResponse(200, existingFile));

      const result = await uploadFileResumable(
        "tok",
        new Uint8Array(10),
        "song.mp3",
        "parent-1",
        undefined,
        { clientGeneratedId: "gen-1" },
      );

      expect(result).toEqual(existingFile);
      expect(mockedFetch).toHaveBeenCalledTimes(3);
      // The real file is fetched by its pre-generated id with the fields the
      // manager needs for the db row (fetch defaults to GET).
      const [getUrl, getOpts] = fetchCallAt(2);
      expect(getUrl).toBe(
        "https://www.googleapis.com/drive/v3/files/gen-1?fields=id,name,mimeType,size,modifiedTime",
      );
      expect(
        (getOpts?.headers as Record<string, string>)["Authorization"],
      ).toBe("Bearer tok");
      // Not an error: info-level log only, uploadManager must not toast.
      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "info",
          message: "idempotent-conflict-resolved",
        }),
      );
    });

    it("initiate 409 + clientGeneratedId → resolves DONE with the real file, no PUT", async () => {
      mockedFetch
        .mockResolvedValueOnce(
          makeErrorBodyResponse(409, "A file with this ID already exists."),
        )
        .mockResolvedValueOnce(makeJsonResponse(200, existingFile));

      const result = await uploadFileResumable(
        "tok",
        new Uint8Array(10),
        "song.mp3",
        "parent-1",
        undefined,
        { clientGeneratedId: "gen-1" },
      );

      expect(result).toEqual(existingFile);
      expect(mockedFetch).toHaveBeenCalledTimes(2);
      expect(fetchCallAt(1)[0]).toContain("/files/gen-1?fields=");
    });

    it("PUT 409 without clientGeneratedId → UploadError invalid (unchanged)", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(
          makeErrorBodyResponse(409, "A file with this ID already exists."),
        );

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
      ).rejects.toMatchObject({ kind: "invalid" });
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    it("initiate 409 without clientGeneratedId → UploadError invalid (unchanged)", async () => {
      mockedFetch.mockResolvedValueOnce(
        makeErrorBodyResponse(409, "A file with this ID already exists."),
      );

      await expect(
        uploadFileResumable("tok", new Uint8Array(3), "a.mp3", "p"),
      ).rejects.toMatchObject({ kind: "invalid" });
      expect(mockedFetch).toHaveBeenCalledTimes(1);
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

  const INITIATE_URL =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
  const LOCATION =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=chunk-123";
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB
  const TOTAL_SIZE = 10_000_000;
  // Mirrors UPLOAD_TIMEOUT_MS in driveApi.ts: each chunk PUT overrides
  // fetchWithAuth's 15s default with the 120s upload bound.
  const PUT_TIMEOUT_MS = 120_000;
  // Mirrors QUERY_STATUS_TIMEOUT_MS in driveApi.ts: the empty query-status PUT
  // is cheap, so it gets a shorter bound than the 120s chunk upload.
  const QUERY_STATUS_TIMEOUT_MS = 20_000;
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
        get: (name: string) =>
          name.toLowerCase() === "location" ? location : null,
      },
      json: () => ({}),
    } as unknown as Response;
  }

  function makeRangeResponse(status: number, range: string | null): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (name: string) => (name.toLowerCase() === "range" ? range : null),
      },
      json: () => ({}),
    } as unknown as Response;
  }

  function makeErrorBodyResponse(
    status: number,
    message: string,
    reason?: string,
  ): Response {
    return makeJsonResponse(status, {
      error: { code: status, message, reason: reason ?? "badRequest" },
    });
  }

  // Offset-capable reader mirroring uploadManager's readChunk contract:
  // returns the slice at `offset`, null when past the end.
  function makeReader(
    bytes: Uint8Array,
    chunkSize: number,
  ): {
    readChunk: (offset: number) => Promise<Uint8Array | null>;
    offsets: number[];
  } {
    const offsets: number[] = [];
    return {
      offsets,
      readChunk: (offset) => {
        offsets.push(offset);
        if (offset >= bytes.length) return Promise.resolve(null);
        return Promise.resolve(bytes.slice(offset, offset + chunkSize));
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

    const [postUrl, postOpts] = fetchCallAt(0);
    expect(postUrl).toBe(INITIATE_URL);
    expect(postOpts?.method).toBe("POST");
    expect(
      (postOpts?.headers as Record<string, string>)["X-Upload-Content-Length"],
    ).toBe(String(TOTAL_SIZE));

    const [put1Url, put1Opts] = fetchCallAt(1);
    expect(put1Url).toBe(LOCATION);
    expect(put1Opts?.method).toBe("PUT");
    const put1Headers = put1Opts?.headers as Record<string, string>;
    expect(put1Headers["Content-Range"]).toBe("bytes 0-8388607/10000000");
    expect(put1Opts?.timeoutMs).toBe(PUT_TIMEOUT_MS);

    const [, put2Opts] = fetchCallAt(2);
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
    const [, put2Opts] = fetchCallAt(2);
    expect((put2Opts?.headers as Record<string, string>)["Content-Range"]).toBe(
      "bytes 4194304-12582911/20000000",
    );
    const [, put3Opts] = fetchCallAt(3);
    expect((put3Opts?.headers as Record<string, string>)["Content-Range"]).toBe(
      "bytes 8388608-16777215/20000000",
    );
    const [, put4Opts] = fetchCallAt(4);
    expect((put4Opts?.headers as Record<string, string>)["Content-Range"]).toBe(
      "bytes 16777216-19999999/20000000",
    );
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
    const [, put1Opts] = fetchCallAt(1);
    const [, put2Opts] = fetchCallAt(2);
    expect((put1Opts?.headers as Record<string, string>)["Content-Range"]).toBe(
      "bytes 0-8388607/8388608",
    );
    expect((put2Opts?.headers as Record<string, string>)["Content-Range"]).toBe(
      "bytes 0-8388607/8388608",
    );
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

  it("chunk PUT 403 rate-limit (rateLimitExceeded) → retried with backoff [1s, 3s], succeeds", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRateLimitResponse(403, "rateLimitExceeded"))
      .mockResolvedValueOnce(
        makeRateLimitResponse(403, "userRateLimitExceeded"),
      )
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    const p = uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: CHUNK_SIZE,
      readChunk: reader.readChunk,
    });
    // Past the 1st backoff (1s) but before the 2nd (3s): the 2nd PUT ran, the
    // 3rd did not — proves the [1s, 3s] delay is honored for 403 retries.
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toEqual(uploadedFile);
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(reader.offsets).toEqual([0]);
  });

  it("chunk PUT 403 rate-limit (userRateLimitExceeded) → retried, succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeRateLimitResponse(403, "userRateLimitExceeded"),
      )
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

  it("chunk PUT 403 non-rate-limit reason (forbidden) → session restarted once; second 403 → invalid", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRateLimitResponse(403, "forbidden"))
      // Query-status on the restart: the 403 (non-rate-limit) also marks the
      // old session dead → the fresh initiate still happens.
      .mockResolvedValueOnce(makeRateLimitResponse(403, "forbidden"))
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRateLimitResponse(403, "forbidden"));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    // Attempt 1: query-status PUT to the old session (dead), then POST
    // initiate + PUT per fresh session (Google: any 4xx → restart the upload).
    expect(mockedFetch).toHaveBeenCalledTimes(5);
    expect(fetchCallAt(0)[0]).toBe(INITIATE_URL);
    expect(fetchCallAt(2)[0]).toBe(LOCATION);
    expect(fetchCallAt(3)[0]).toBe(INITIATE_URL);
    // The restarted session re-uploads from offset 0.
    expect(reader.offsets).toEqual([0, 0]);
  });

  it("404 on a chunk PUT → restarts a whole new session (POST + PUT again), succeeds", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(404, null))
      // Query-status on the restart confirms the old session is dead → the
      // fresh initiate uploads from 0.
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
    expect(mockedFetch).toHaveBeenCalledTimes(5);
    expect(fetchCallAt(0)[0]).toBe(INITIATE_URL);
    expect(fetchCallAt(1)[0]).toBe(LOCATION);
    expect(fetchCallAt(2)[0]).toBe(LOCATION);
    expect(fetchCallAt(3)[0]).toBe(INITIATE_URL);
    expect(fetchCallAt(4)[0]).toBe(LOCATION);
    // A fresh session re-uploads from offset 0.
    expect(reader.offsets).toEqual([0, 0]);
  });

  it("404 twice → network UploadError after 2 session attempts", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(404, null))
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
      }),
    ).rejects.toMatchObject({ kind: "network" });
    expect(mockedFetch).toHaveBeenCalledTimes(5);
  });

  it("chunk PUT 400 → session restarted exactly once (fresh initiate); second 400 → UploadError invalid with status", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Invalid upload request"),
      )
      // Query-status on the restart: the 400 also marks the old session dead.
      .mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Invalid upload request"),
      )
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Invalid upload request"),
      );

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      }),
    ).rejects.toMatchObject({
      name: "UploadError",
      kind: "invalid",
      message: "upload failed (status=400)",
    });
    // Session 1: POST initiate + PUT(400). Query: PUT(400) → dead.
    // Session 2: POST initiate + PUT(400).
    expect(mockedFetch).toHaveBeenCalledTimes(5);
    expect(fetchCallAt(0)[0]).toBe(INITIATE_URL);
    expect(fetchCallAt(1)[0]).toBe(LOCATION);
    expect(fetchCallAt(2)[0]).toBe(LOCATION);
    expect(fetchCallAt(3)[0]).toBe(INITIATE_URL);
    expect(fetchCallAt(4)[0]).toBe(LOCATION);
    // The restarted session re-uploads from offset 0.
    expect(reader.offsets).toEqual([0, 0]);
  });

  it("chunk PUT 400 → silent restart (warn with attempt, no error surface) and the fresh session succeeds", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Invalid upload request"),
      )
      // Query-status on the restart: the 400 marks the old session dead.
      .mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Invalid upload request"),
      )
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
    expect(mockedFetch).toHaveBeenCalledTimes(5);
    expect(reader.offsets).toEqual([0, 0]);
    // The restart is silent: warn-level log with the attempt counter — no
    // error-level entry (uploadManager decides toasts, terminal failures only).
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "upload-session-expired (attempt=1/2)",
        ) as unknown as string,
      }),
    );
  });

  it("caller abort mid-upload → aborted, no chunk retry, no session restart", async () => {
    const controller = new AbortController();
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockImplementationOnce(() => {
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
      }),
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
        readChunk: () => Promise.resolve(makePayload(10)),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("totalSize 0 → invalid, no network calls", async () => {
    await expect(
      uploadFileResumableChunked("tok", {
        name: "empty.flac",
        parentId: "p",
        totalSize: 0,
        readChunk: () => Promise.resolve(null),
      }),
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
          "storageQuotaExceeded",
        ),
      );

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      }),
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
      }),
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
      }),
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
        readChunk: () => {
          throw new Error("disk io error");
        },
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("file growth: readChunk overshoots totalSize → chunk truncated to the remaining bytes, final chunk sent with exact Content-Range", async () => {
    // The file was still being written when the upload started (user dropped
    // a half-downloaded file): the streamed bytes exceed the stat-ed size.
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-63"))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const offsets: number[] = [];
    const fractions: number[] = [];
    const result = await uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: 100,
      readChunk: (offset) => {
        offsets.push(offset);
        // Still growing: every read returns a full 64-byte chunk, including
        // the one at offset 64 that overshoots totalSize=100.
        return Promise.resolve(offset >= 100 ? null : makePayload(64));
      },
      onProgress: (f) => fractions.push(f),
    });

    expect(result).toEqual(uploadedFile);
    expect(offsets).toEqual([0, 64]);
    expect(fractions).toEqual([64 / 100, 1]);

    expect(mockedFetch).toHaveBeenCalledTimes(3);
    const [, put1Opts] = fetchCallAt(1);
    expect((put1Opts?.headers as Record<string, string>)["Content-Range"]).toBe(
      "bytes 0-63/100",
    );
    const [, put2Opts] = fetchCallAt(2);
    expect((put2Opts?.headers as Record<string, string>)["Content-Range"]).toBe(
      "bytes 64-99/100",
    );
    // The truncated final chunk is 36 bytes — not a 256 KB multiple, which is
    // fine: the multiple rule only applies to non-final chunks.
    expect((put2Opts?.body as Uint8Array).byteLength).toBe(36);
  });

  it("file growth persists: every chunk truncated to totalSize, upload never exceeds it", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-19"))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-39"))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    await uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: 50,
      readChunk: (offset) =>
        Promise.resolve(offset >= 100 ? null : makePayload(64)),
    });

    const bodies: number[] = mockedFetch.mock.calls
      .slice(1)
      .map(([, o]) => (o?.body as Uint8Array).byteLength);
    expect(bodies).toEqual([50, 30, 10]);
    const ranges = mockedFetch.mock.calls
      .slice(1)
      .map(([, o]) => (o?.headers as Record<string, string>)["Content-Range"]);
    expect(ranges).toEqual([
      "bytes 0-49/50",
      "bytes 20-49/50",
      "bytes 40-49/50",
    ]);
  });

  it("file growth truncation is silent: chunk still truncated to totalSize, no upload-chunk-truncated log", async () => {
    // The file was still being written when the upload started, so the final
    // chunk overshoots totalSize and must be trimmed — this is the SUCCESS
    // path. The upload-chunk-truncated warn was removed because it fired on
    // every growing-file upload (i.e. normal completion), so it must NOT log.
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    await uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: 50,
      readChunk: (offset) =>
        Promise.resolve(offset >= 50 ? null : makePayload(64)),
    });

    expect(captureError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "upload-chunk-truncated",
        ) as unknown as string,
      }),
    );
    // Truncation behavior itself is unchanged: the 64-byte chunk is cut to the
    // remaining 50 bytes and sent with the exact Content-Range.
    const [, putOpts] = fetchCallAt(1);
    expect((putOpts?.headers as Record<string, string>)["Content-Range"]).toBe(
      "bytes 0-49/50",
    );
    expect((putOpts?.body as Uint8Array).byteLength).toBe(50);
  });

  it("offset >= totalSize (308 full-range after the final truncated chunk) → invalid, no further PUT", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-9"));

    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: 10,
        readChunk: (offset) =>
          Promise.resolve(offset >= 10 ? null : makePayload(CHUNK_SIZE)),
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    // initiate + the single truncated PUT — never a resend past the announced size.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("308 Range covering the whole file → invalid (server anomaly, would re-send out of range)", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeRangeResponse(308, `bytes=0-${String(TOTAL_SIZE - 1)}`),
      );

    const reader = makeReader(makePayload(TOTAL_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: TOTAL_SIZE,
        readChunk: reader.readChunk,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("logs warn captureError with status=400 when a chunk PUT hits a non-retryable 4xx (both session attempts)", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Invalid upload request"),
      )
      // Query-status on the restart also answers 400 → session dead.
      .mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Invalid upload request"),
      )
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(
        makeErrorBodyResponse(400, "Invalid upload request"),
      );

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    await expect(
      uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(mockedFetch).toHaveBeenCalledTimes(5);

    const message = vi
      .mocked(captureError)
      .mock.calls.map((c) => c[0].message)
      .join("\n");
    expect(message).toContain("status=400");
    expect(message).toContain("Invalid upload request");
  });

  // Upgrade 1: the chunk retry delay must come from backoffDelay, which honors
  // Retry-After (RFC 6585/9110). Old fixed delay [1000, 3000] ignored the
  // header and re-fired the 429 after 1s; with Retry-After: 5 the retry must
  // wait a full 5000ms (backoffDelay(0, "5") is deterministic — no jitter).
  it("chunk 429 with Retry-After: 5 → waits the full 5s before the retry", async () => {
    vi.useFakeTimers();
    const retryAfterResponse = {
      status: 429,
      ok: false,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? "5" : null,
      },
      json: () => ({}),
    } as unknown as Response;
    mockedFetch
      .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
      .mockResolvedValueOnce(retryAfterResponse)
      .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

    const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
    const p = uploadFileResumableChunked("tok", {
      name: "big.flac",
      parentId: "p",
      totalSize: CHUNK_SIZE,
      readChunk: reader.readChunk,
    });
    // Old code: delay[attempt 0] = 1000ms → retry already fired at t=1000
    // (3rd fetch). New code: Retry-After "5" → 5000ms → still only 2 calls.
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual(uploadedFile);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(reader.offsets).toEqual([0]);
  });

  // Upgrade 1: without Retry-After, the delay must come from backoffDelay's
  // exponential + jitter (attempt 0 = 1000ms + up to 50% jitter) instead of
  // the fixed 1000ms. Math.random is stubbed to 0.5 so the jitter is
  // deterministic: 1000 + (0.5 * 1000 * 0.5) = 1250ms.
  it("chunk 429 without Retry-After → jittered expo backoff (1250ms with stubbed jitter)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
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
      // Old code: fixed 1000ms → retry fired at t=1000 (3rd fetch). New code:
      // 1250ms → at t=1000 the retry must NOT have fired yet.
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockedFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(await p).toEqual(uploadedFile);
      expect(mockedFetch).toHaveBeenCalledTimes(3);
      expect(reader.offsets).toEqual([0]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  // Idempotent upload (Slice 1) on the chunked path: session restarts stay
  // bound to the SAME pre-generated id, so a retry of a response-lost success
  // answers 409 and resolves DONE with the real file (no duplicate).
  describe("idempotent upload (clientGeneratedId)", () => {
    const existingFile: DriveFileItem = {
      id: "gen-1",
      name: "big.flac",
      mimeType: "audio/flac",
      size: "8388608",
    };

    it("initiate metadata body carries the pre-generated id", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
        clientGeneratedId: "gen-1",
      });

      const [postUrl, postOpts] = fetchCallAt(0);
      expect(postUrl).toBe(INITIATE_URL);
      expect(JSON.parse(postOpts?.body as string)).toEqual({
        name: "big.flac",
        parents: ["p"],
        id: "gen-1",
      });
    });

    it("chunk PUT 409 + clientGeneratedId → resolves DONE with the real file (no duplicate)", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(
          makeErrorBodyResponse(409, "A file with this ID already exists."),
        )
        .mockResolvedValueOnce(makeJsonResponse(200, existingFile));

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
        clientGeneratedId: "gen-1",
      });

      expect(result).toEqual(existingFile);
      expect(mockedFetch).toHaveBeenCalledTimes(3);
      expect(fetchCallAt(2)[0]).toBe(
        "https://www.googleapis.com/drive/v3/files/gen-1?fields=id,name,mimeType,size,modifiedTime",
      );
      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "info",
          message: "idempotent-conflict-resolved",
        }),
      );
    });

    it("initiate 409 + clientGeneratedId → resolves DONE with the real file, no PUT", async () => {
      mockedFetch
        .mockResolvedValueOnce(
          makeErrorBodyResponse(409, "A file with this ID already exists."),
        )
        .mockResolvedValueOnce(makeJsonResponse(200, existingFile));

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
        clientGeneratedId: "gen-1",
      });

      expect(result).toEqual(existingFile);
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    it("chunk PUT 409 without clientGeneratedId → session restarted once; second 409 → UploadError invalid", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(
          makeErrorBodyResponse(409, "A file with this ID already exists."),
        )
        // Query-status on the restart: 409 without a pre-generated id is a
        // plain 4xx → old session dead → fresh initiate.
        .mockResolvedValueOnce(
          makeErrorBodyResponse(409, "A file with this ID already exists."),
        )
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(
          makeErrorBodyResponse(409, "A file with this ID already exists."),
        );

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      await expect(
        uploadFileResumableChunked("tok", {
          name: "big.flac",
          parentId: "p",
          totalSize: CHUNK_SIZE,
          readChunk: reader.readChunk,
        }),
      ).rejects.toMatchObject({ kind: "invalid" });
      // A 409 without a pre-generated id is a plain 4xx → query-status marks
      // the old session dead, one restart, then the concrete UploadError invalid.
      expect(mockedFetch).toHaveBeenCalledTimes(5);
    });
  });

  // Slice 3 (upload resilience): before paying for a fresh session on a
  // restart, query the OLD session's status (empty PUT with Content-Range
  // */<total>). A surviving session resumes at the server-confirmed byte — no
  // re-upload of bytes Drive already holds; 200/201 → the upload is already
  // done; 404/other-4xx → the session is dead → fresh initiate from 0.
  describe("query-status before session restart (Slice 3)", () => {
    // How many fresh session initiates happened across the whole upload.
    function countInitiates(): number {
      return mockedFetch.mock.calls.filter(([url]) => url === INITIATE_URL)
        .length;
    }

    function networkLoss(): () => never {
      return () => {
        throw new TypeError("network connection lost");
      };
    }

    it("transient chunk failure → query-status 308 + Range → resumes the SAME session at lastByte+1 (no new initiate)", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
        .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-524287"))
        .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-8912895"))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const reader = makeReader(makePayload(TOTAL_SIZE), CHUNK_SIZE);
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: TOTAL_SIZE,
        readChunk: reader.readChunk,
      });

      expect(result).toEqual(uploadedFile);
      // The surviving session is resumed — NEVER re-initiated.
      expect(countInitiates()).toBe(1);
      // Chunks continue from the server-confirmed byte (524287 + 1), then the tail.
      expect(reader.offsets).toEqual([0, 524288, 8912896]);

      const [queryUrl, queryOpts] = fetchCallAt(2);
      expect(queryUrl).toBe(LOCATION);
      expect(queryOpts?.method).toBe("PUT");
      const queryHeaders = queryOpts?.headers as Record<string, string>;
      expect(queryHeaders["Content-Range"]).toBe("*/10000000");
      expect(queryOpts?.body).toBeUndefined();
      expect(queryOpts?.timeoutMs).toBe(QUERY_STATUS_TIMEOUT_MS);
    });

    it("query-status 200 → the upload already completed server-side → returns the file, no re-upload", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
        .mockResolvedValueOnce(makeJsonResponse(200, uploadedFile));

      const reader = makeReader(makePayload(TOTAL_SIZE), CHUNK_SIZE);
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: TOTAL_SIZE,
        readChunk: reader.readChunk,
      });

      expect(result).toEqual(uploadedFile);
      // No bytes were re-sent — only the initiate + the failed chunk + the query.
      expect(mockedFetch).toHaveBeenCalledTimes(3);
      expect(reader.offsets).toEqual([0]);
      expect(countInitiates()).toBe(1);
    });

    it("query-status 404 → session dead → fresh initiate uploads from offset 0", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
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
      expect(countInitiates()).toBe(2);
      // The fresh session re-uploads from offset 0 (the old session holds nothing usable).
      expect(reader.offsets).toEqual([0, 0]);
      expect(fetchCallAt(3)[0]).toBe(INITIATE_URL);
    });

    it("query-status 400 (non-retryable 4xx) → session dead → fresh initiate from 0", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
        .mockResolvedValueOnce(
          makeErrorBodyResponse(400, "Invalid upload request"),
        )
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
      expect(countInitiates()).toBe(2);
      expect(reader.offsets).toEqual([0, 0]);
    });

    it("query-status 500 → retried once → 200 on the retry → done, no re-upload", async () => {
      vi.useFakeTimers();
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
        .mockResolvedValueOnce(makeRangeResponse(500, null))
        .mockResolvedValueOnce(makeJsonResponse(200, uploadedFile));

      const reader = makeReader(makePayload(TOTAL_SIZE), CHUNK_SIZE);
      const p = uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: TOTAL_SIZE,
        readChunk: reader.readChunk,
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await p).toEqual(uploadedFile);
      expect(mockedFetch).toHaveBeenCalledTimes(4);
      expect(reader.offsets).toEqual([0]);
    });

    it("query-status 5xx retries exhausted → treated as transient → fresh initiate from 0 (upload still succeeds)", async () => {
      vi.useFakeTimers();
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
        .mockResolvedValueOnce(makeRangeResponse(500, null))
        .mockResolvedValueOnce(makeRangeResponse(500, null))
        .mockResolvedValueOnce(makeRangeResponse(500, null))
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      const p = uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(await p).toEqual(uploadedFile);
      expect(mockedFetch).toHaveBeenCalledTimes(7);
      expect(reader.offsets).toEqual([0, 0]);
    });

    it("query-status 308 without Range → nothing received → continues the SAME session from 0", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
        .mockResolvedValueOnce(makeRangeResponse(308, null))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      });

      expect(result).toEqual(uploadedFile);
      expect(countInitiates()).toBe(1);
      // Same session, but no byte was ever received → chunk re-sent from 0.
      expect(reader.offsets).toEqual([0, 0]);
    });

    it("query-status 403 quota → quota UploadError, no restart, no new initiate", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
        .mockResolvedValueOnce(
          makeErrorBodyResponse(
            403,
            "The user's Drive storage quota has been exceeded.",
            "storageQuotaExceeded",
          ),
        );

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      await expect(
        uploadFileResumableChunked("tok", {
          name: "big.flac",
          parentId: "p",
          totalSize: CHUNK_SIZE,
          readChunk: reader.readChunk,
        }),
      ).rejects.toMatchObject({ kind: "quota" });
      expect(countInitiates()).toBe(1);
    });

    it("first attempt (no previous session) → NO query-status before initiate", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
      });

      expect(mockedFetch).toHaveBeenCalledTimes(2);
      expect(fetchCallAt(0)[0]).toBe(INITIATE_URL);
      // No empty PUT with a wildcard Content-Range was ever sent.
      const wildcardRanges = mockedFetch.mock.calls.filter(([, opts]) =>
        ((opts?.headers as Record<string, string> | undefined) ?? {})[
          "Content-Range"
        ]?.startsWith("*/"),
      );
      expect(wildcardRanges).toHaveLength(0);
    });

    it("caller abort during query-status → aborted, no session restart", async () => {
      const controller = new AbortController();
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockImplementationOnce(networkLoss())
        .mockImplementationOnce(() => {
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
        }),
      ).rejects.toMatchObject({ kind: "aborted" });
      expect(mockedFetch).toHaveBeenCalledTimes(3);
    });
  });

  // Slice 5.2: an upload resumed from a session URI persisted by an earlier
  // run — attempt 0 goes through query-status on the persisted URI instead of
  // paying for a fresh initiate; onSessionUpdate hands every NEW session URI
  // (post-initiate) to the caller so the manager can persist it.
  describe("resume from persisted session (Slice 5.2)", () => {
    const PERSISTED_URI =
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=persisted-1";

    function countInitiates(): number {
      return mockedFetch.mock.calls.filter(([url]) => url === INITIATE_URL)
        .length;
    }

    it("(a) initialUploadUri + query 308 → resumes the SAME session at lastByte+1, zero initiates, no onSessionUpdate", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-524287"))
        .mockResolvedValueOnce(makeRangeResponse(308, "bytes=0-8912895"))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const reader = makeReader(makePayload(TOTAL_SIZE), CHUNK_SIZE);
      const sessionUpdates: string[] = [];
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: TOTAL_SIZE,
        readChunk: reader.readChunk,
        initialUploadUri: PERSISTED_URI,
        onSessionUpdate: (uri) => sessionUpdates.push(uri),
      });

      expect(result).toEqual(uploadedFile);
      expect(countInitiates()).toBe(0);
      expect(sessionUpdates).toHaveLength(0);
      // The first chunk resumes at the server-confirmed byte (524287 + 1).
      expect(reader.offsets).toEqual([524288, 8912896]);

      const [queryUrl, queryOpts] = fetchCallAt(0);
      expect(queryUrl).toBe(PERSISTED_URI);
      expect(queryOpts?.method).toBe("PUT");
      expect(
        (queryOpts?.headers as Record<string, string>)["Content-Range"],
      ).toBe("*/10000000");
      expect(queryOpts?.timeoutMs).toBe(QUERY_STATUS_TIMEOUT_MS);
    });

    it("(b) initialUploadUri + query 200 → the upload already completed → returns the file, zero initiates, no chunks", async () => {
      mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, uploadedFile));

      const reader = makeReader(makePayload(TOTAL_SIZE), CHUNK_SIZE);
      const sessionUpdates: string[] = [];
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: TOTAL_SIZE,
        readChunk: reader.readChunk,
        initialUploadUri: PERSISTED_URI,
        onSessionUpdate: (uri) => sessionUpdates.push(uri),
      });

      expect(result).toEqual(uploadedFile);
      expect(countInitiates()).toBe(0);
      expect(reader.offsets).toEqual([]);
      expect(sessionUpdates).toHaveLength(0);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it("(c) initialUploadUri + query 404 → session dead → fresh initiate uploads from 0 + onSessionUpdate fires", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeRangeResponse(404, null))
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const reader = makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE);
      const sessionUpdates: string[] = [];
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: reader.readChunk,
        initialUploadUri: PERSISTED_URI,
        onSessionUpdate: (uri) => sessionUpdates.push(uri),
      });

      expect(result).toEqual(uploadedFile);
      expect(countInitiates()).toBe(1);
      expect(reader.offsets).toEqual([0]);
      expect(fetchCallAt(1)[0]).toBe(INITIATE_URL);
      expect(sessionUpdates).toEqual([LOCATION]);
    });

    it("(d) no initialUploadUri → onSessionUpdate fires with the fresh session URI after initiate", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const sessionUpdates: string[] = [];
      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE).readChunk,
        onSessionUpdate: (uri) => sessionUpdates.push(uri),
      });

      expect(result).toEqual(uploadedFile);
      expect(sessionUpdates).toEqual([LOCATION]);
    });

    it("a throwing onSessionUpdate is caught + logged — the upload still completes", async () => {
      mockedFetch
        .mockResolvedValueOnce(makeLocationResponse(200, LOCATION))
        .mockResolvedValueOnce(makeJsonResponse(201, uploadedFile));

      const result = await uploadFileResumableChunked("tok", {
        name: "big.flac",
        parentId: "p",
        totalSize: CHUNK_SIZE,
        readChunk: makeReader(makePayload(CHUNK_SIZE), CHUNK_SIZE).readChunk,
        onSessionUpdate: () => {
          throw new Error("persist failed");
        },
      });

      expect(result).toEqual(uploadedFile);
      // The ONLY warn log in this flow is the caught onSessionUpdate failure —
      // the throw must not break the upload.
      expect(captureError).toHaveBeenCalledTimes(1);
      expect(captureError).toHaveBeenCalledWith(
        expect.objectContaining({ level: "warn" }),
      );
    });
  });
});

describe("generateClientId", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("POSTs generateIds?count=1 with Bearer and returns the generated id", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(200, { ids: ["gen-abc"], space: "drive" }),
    );

    const id = await generateClientId("tok");

    expect(id).toBe("gen-abc");
    const [url, opts] = fetchCallAt(0);
    expect(url).toBe(
      "https://www.googleapis.com/drive/v3/files/generateIds?count=1",
    );
    expect(opts?.method).toBe("POST");
    expect((opts?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok",
    );
  });

  it("non-2xx → UploadError invalid", async () => {
    mockedFetch.mockResolvedValueOnce(
      makeJsonResponse(400, {
        error: { code: 400, message: "Bad Request" },
      }),
    );

    await expect(generateClientId("tok")).rejects.toMatchObject({
      name: "UploadError",
      kind: "invalid",
    });
  });

  it("empty ids array → UploadError invalid", async () => {
    mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, { ids: [] }));

    await expect(generateClientId("tok")).rejects.toMatchObject({
      name: "UploadError",
      kind: "invalid",
    });
  });

  it("non-object body → UploadError invalid", async () => {
    mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, "oops"));

    await expect(generateClientId("tok")).rejects.toMatchObject({
      name: "UploadError",
      kind: "invalid",
    });
  });
});

describe("saveAppConfig serialization lock (promise-chain mutex)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes concurrent saves: task 2's fetch only starts after task 1 fully finishes", async () => {
    let releaseFirstSearch!: () => void;
    const firstSearchGate = new Promise<Response>((resolve) => {
      releaseFirstSearch = () => {
        resolve(makeJsonResponse(200, { files: [{ id: "file-1" }] }));
      };
    });

    mockedFetch
      .mockReturnValueOnce(firstSearchGate) // task 1: search (held open)
      .mockResolvedValueOnce(makeResponse(200)) // task 1: PATCH upload
      .mockResolvedValueOnce(makeJsonResponse(200, { files: [] })) // task 2: search (no file → POST)
      .mockResolvedValueOnce(makeResponse(200)); // task 2: POST upload

    const task1 = saveAppConfig("tok-1", { a: 1 });
    const task2 = saveAppConfig("tok-2", { a: 2 });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    releaseFirstSearch();
    const results = await Promise.all([task1, task2]);
    expect(results).toEqual([true, true]);
    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it("a rejected task does not block the next task (lock is always released)", async () => {
    const order: string[] = [];
    const task1 = withSaveConfigLock(() => {
      order.push("t1");
      throw new Error("save failed");
    });
    await expect(task1).rejects.toThrow("save failed");

    const result = await withSaveConfigLock(() => {
      order.push("t2");
      return Promise.resolve(42);
    });
    expect(result).toBe(42);
    expect(order).toEqual(["t1", "t2"]);
  });
});
