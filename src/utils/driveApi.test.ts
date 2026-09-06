import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  backoffDelay,
  classifyDriveError,
  createFolder,
  deleteFile,
  driveFetch,
  getFileParents,
  getFileName,
  moveFile,
  restoreFile,
  getAppConfig,
  getDriveStorageQuota,
  permanentlyDeleteFile,
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

// Mock the auth-bound transport so we can simulate Drive API responses and
// exercise driveFetch's retry/backoff path without real network calls.
vi.mock("./apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock("./errorLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./errorLog")>()),
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
// not at error.reason. The shape change exercises driveApi.isRateLimitError
// through the shared isRateLimit403Response.
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

// Shared retryable-status check for the Drive retry loop (driveFetch):
// 429/5xx by status alone, 403 only when the body reports a Drive rate-limit
// reason (read via clone, only while retries remain so the final attempt
// never consumes the body).
describe("classifyDriveError name-based classification", () => {
  it('classifies a caller-abort DOMException ("AbortError") as "timeout"', () => {
    expect(classifyDriveError(new DOMException("aborted", "AbortError"))).toBe(
      "timeout",
    );
  });

  it('classifies an error named "TimeoutError" as "timeout" even without "timeout" in the message', () => {
    expect(
      classifyDriveError(new DOMException("signal timed out", "TimeoutError")),
    ).toBe("timeout");
  });
});

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
    // 501 is retryable under driveFetch's 5xx range formula — the predicate
    // must preserve it.
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

  // Mirror of driveRangeTokenizer's "caller abort during 429 backoff exits
  // immediately" regression: a retryable-status response (429/5xx + Retry-After)
  // that resolves AFTER the caller cancelled must not park the loop in the
  // full backoff sleep (up to MAX_DELAY_MS = 32s) just to fire one doomed
  // attempt afterwards.
  it("caller abort when a retryable-status response resolves exits immediately instead of sleeping", async () => {
    const controller = new AbortController();
    const retryAfterResponse = {
      status: 500,
      ok: false,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? "32" : null,
      },
      json: () => ({}),
    } as unknown as Response;
    mockedFetch.mockImplementationOnce(() => {
      // Caller cancels exactly when the failed response arrives — the signal
      // is already aborted the moment the backoff sleep would start.
      controller.abort();
      return Promise.resolve(retryAfterResponse);
    });

    let settled = false;
    const guarded = driveFetch("https://www.googleapis.com/drive/v3/files", {
      signal: controller.signal,
    }).then(
      (v) => {
        settled = true;
        return v;
      },
      (e: unknown) => {
        settled = true;
        return e;
      },
    );
    // 1ms of fake time: enough for the response microtasks to run, nowhere
    // near the 32s Retry-After — the rejection must already have happened
    // with NO second fetch attempt queued behind the sleep.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const err = await guarded;
    expect(err).toBeInstanceOf(DOMException);
    expect(err).toMatchObject({ name: "AbortError" });
    expect(mockedFetch).toHaveBeenCalledTimes(1); // no doomed second attempt
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
// cancel of an in-flight folder creation aborts the Drive request (Bug 1d).
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

// Single-item responses (create/delete/move/restore) are narrowed before use:
// a malformed body must fail in a controlled way instead of leaking an
// object missing required fields to the caller.
describe("single-item response narrowing", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createFolder throws on a malformed body", async () => {
    mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, {}));
    await expect(createFolder("tok", "Album", "root")).rejects.toThrow(
      /invalid response/,
    );
  });

  it("deleteFile throws on a malformed body", async () => {
    mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, {}));
    await expect(deleteFile("tok", "f1")).rejects.toThrow(/invalid response/);
  });

  it("moveFile throws on a malformed body", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeJsonResponse(200, { parents: ["root"] }))
      .mockResolvedValueOnce(makeJsonResponse(200, {}));
    await expect(moveFile("tok", "f1", "root", "target")).rejects.toThrow(
      /invalid response/,
    );
  });

  it("restoreFile throws on a malformed body", async () => {
    mockedFetch.mockResolvedValueOnce(makeJsonResponse(200, {}));
    await expect(restoreFile("tok", "f1")).rejects.toThrow(/invalid response/);
  });
});

// Same upgrade as drivePagination: a 200 response whose body is not valid JSON
// (proxy truncation, wrong Content-Type, server bug) must reject with a
// classified error instead of a raw SyntaxError leaking out of response.json()
// — for the single-item actions AND the null-contract getters (which still
// return null on non-ok; only an unreadable ok-body becomes a thrown error).
describe("driveFiles malformed JSON body", () => {
  function makeNonJsonResponse(): Response {
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: () => {
        throw new SyntaxError(
          "Unexpected token 'n', \"not-json{\" is not valid JSON",
        );
      },
    } as unknown as Response;
  }

  beforeEach(() => {
    mockedFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createFolder throws `Failed to create folder (invalid response)` when json() rejects", async () => {
    mockedFetch.mockResolvedValueOnce(makeNonJsonResponse());

    await expect(createFolder("tok", "Album", "root")).rejects.toThrow(
      "Failed to create folder (invalid response)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("deleteFile throws `Failed to delete file (invalid response)` when json() rejects", async () => {
    mockedFetch.mockResolvedValueOnce(makeNonJsonResponse());

    await expect(deleteFile("tok", "f1")).rejects.toThrow(
      "Failed to delete file (invalid response)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("moveFile throws `Failed to move file (invalid response)` when the parents GET json() rejects", async () => {
    mockedFetch.mockResolvedValueOnce(makeNonJsonResponse());

    await expect(moveFile("tok", "f1", "root", "target")).rejects.toThrow(
      "Failed to move file (invalid response)",
    );
    // The GET failed to parse — the PATCH move request must not be fired.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("moveFile throws `Failed to move file (invalid response)` when the move PATCH json() rejects", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeJsonResponse(200, { parents: ["root"] }))
      .mockResolvedValueOnce(makeNonJsonResponse());

    await expect(moveFile("tok", "f1", "root", "target")).rejects.toThrow(
      "Failed to move file (invalid response)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("restoreFile throws `Failed to restore file (invalid response)` when json() rejects", async () => {
    mockedFetch.mockResolvedValueOnce(makeNonJsonResponse());

    await expect(restoreFile("tok", "f1")).rejects.toThrow(
      "Failed to restore file (invalid response)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("getFileParents throws `Failed to get file parents (invalid response)` when json() rejects", async () => {
    mockedFetch.mockResolvedValueOnce(makeNonJsonResponse());

    await expect(getFileParents("tok", "f1")).rejects.toThrow(
      "Failed to get file parents (invalid response)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("getFileName throws `Failed to get file name (invalid response)` when json() rejects", async () => {
    mockedFetch.mockResolvedValueOnce(makeNonJsonResponse());

    await expect(getFileName("tok", "f1")).rejects.toThrow(
      "Failed to get file name (invalid response)",
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

// P1-1: every fileId is interpolated into a URL path segment and must be
// percent-encoded first. Standard Drive ids ([A-Za-z0-9_-]) are unaffected
// (encodeURIComponent is a no-op on them — every existing URL assertion stays
// green); this guard exists so an id containing reserved characters can never
// split the path or leak into the query string.
describe("driveFiles encodes fileId path segments (P1-1)", () => {
  const weirdId = "abc/def?id x";
  const encodedId = encodeURIComponent(weirdId);

  beforeEach(() => {
    mockedFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("deleteFile / restoreFile / permanentlyDeleteFile encode the path segment", async () => {
    const item = { id: weirdId, name: "n", mimeType: "audio/mpeg" };
    mockedFetch
      .mockResolvedValueOnce(makeJsonResponse(200, item))
      .mockResolvedValueOnce(makeJsonResponse(200, item))
      .mockResolvedValueOnce(makeResponse(204));

    await deleteFile("tok", weirdId);
    await restoreFile("tok", weirdId);
    await expect(permanentlyDeleteFile("tok", weirdId)).resolves.toBe(true);

    const expectedUrl = `https://www.googleapis.com/drive/v3/files/${encodedId}`;
    expect(fetchCallAt(0)[0]).toBe(expectedUrl);
    expect(fetchCallAt(1)[0]).toBe(expectedUrl);
    expect(fetchCallAt(2)[0]).toBe(expectedUrl);
  });

  it("moveFile encodes the path segment on GET + PATCH and encodes addParents/removeParents", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeJsonResponse(200, { parents: ["p1"] }))
      .mockResolvedValueOnce(
        makeJsonResponse(200, {
          id: weirdId,
          name: "n",
          mimeType: "audio/mpeg",
        }),
      );

    await moveFile("tok", weirdId, "old/parent", "new/parent");

    expect(fetchCallAt(0)[0]).toBe(
      `https://www.googleapis.com/drive/v3/files/${encodedId}?fields=parents`,
    );
    expect(fetchCallAt(1)[0]).toBe(
      `https://www.googleapis.com/drive/v3/files/${encodedId}?${new URLSearchParams(
        {
          addParents: "new/parent",
          removeParents: "p1",
        },
      ).toString()}`,
    );
  });

  it("getFileParents / getFileName encode the path segment", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeJsonResponse(200, {}))
      .mockResolvedValueOnce(makeJsonResponse(200, {}));

    await getFileParents("tok", weirdId);
    await getFileName("tok", weirdId);

    expect(fetchCallAt(0)[0]).toBe(
      `https://www.googleapis.com/drive/v3/files/${encodedId}?fields=parents`,
    );
    expect(fetchCallAt(1)[0]).toBe(
      `https://www.googleapis.com/drive/v3/files/${encodedId}?fields=name`,
    );
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

// Upgrade: saveAppConfig must NOT blind-POST when the config search itself
// fails (non-ok). Pre-fix a failed search still POSTed a new file — a
// transient 4xx (e.g. 403) during first-save could create a second duplicate
// drplay_config.json in appDataFolder (Drive has no conditional upsert).
// Now: search fail → warn + return false, no upload request is made.
describe("saveAppConfig search-failure guard (no blind POST)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });

  it("search fails (non-ok) → returns false WITHOUT POSTing a new file", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeJsonResponse(400, {})) // search: non-ok
      .mockResolvedValueOnce(makeResponse(200)); // would-be upload — must NOT happen

    const saved = await saveAppConfig("tok-1", { a: 1 });

    expect(saved).toBe(false);
    // Only the search request happened — no upload call.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(fetchCallAt(0)[0]).toContain("spaces=appDataFolder");
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: "config-search-failed, skip upload",
      }),
    );
  });
});

// Upgrade: getAppConfig must forward a caller AbortSignal into the Drive
// fetches (driveFetch turns the abort into an immediate non-retried
// rejection). Pre-fix the signal was dropped, so a cancelled init (unmount /
// token refresh) still issued network calls.
describe("getAppConfig caller abort signal", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });

  it("aborted caller signal → driveFetch rejects inside → returns null, never reads the file", async () => {
    const controller = new AbortController();
    controller.abort();
    mockedFetch.mockImplementation((_url, opts) => {
      if (opts?.signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(
        makeJsonResponse(200, { files: [{ id: "file-1" }] }),
      );
    });

    const result = await getAppConfig("tok-1", controller.signal);

    expect(result).toBeNull();
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining(
          "get-config-failed",
        ) as unknown as string,
      }),
    );
  });
});

// P1-1 cross-finding mirror: driveConfig interpolates the config fileId into
// an upload URL path segment and must percent-encode it first (same guard as
// driveFiles above). Standard Drive ids ([A-Za-z0-9_-]) are unaffected —
// encodeURIComponent is a no-op on them; a reserved-char id must never split
// the path or leak into the query string.
describe("driveConfig encodes config fileId in upload URL (P1-1 mirror)", () => {
  const weirdId = "abc/def?id x";
  const encodedId = encodeURIComponent(weirdId);

  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });

  it("saveAppConfig PATCHes the existing config at an encoded upload path segment", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        makeJsonResponse(200, { files: [{ id: weirdId }] }),
      ) // search finds existing config
      .mockResolvedValueOnce(makeResponse(200)); // PATCH upload

    await expect(saveAppConfig("tok-1", { a: 1 })).resolves.toBe(true);

    expect(fetchCallAt(0)[0]).toContain("spaces=appDataFolder");
    expect(fetchCallAt(1)[0]).toBe(
      `https://www.googleapis.com/upload/drive/v3/files/${encodedId}?uploadType=multipart`,
    );
  });

  it("saveAppConfig first save POSTs the standard query-only upload URL", async () => {
    mockedFetch
      .mockResolvedValueOnce(makeJsonResponse(200, { files: [] })) // search: no file yet
      .mockResolvedValueOnce(makeResponse(200)); // POST upload

    await expect(saveAppConfig("tok-1", { a: 1 })).resolves.toBe(true);

    expect(fetchCallAt(1)[0]).toBe(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    );
  });
});

// Mirror of commit 17cdaec for the READ path: getAppConfig interpolates the
// config fileId into a download URL path segment and must percent-encode it
// first (same guard as the saveAppConfig upload URL above). Standard Drive ids
// ([A-Za-z0-9_-]) are unaffected — encodeURIComponent is a no-op on them; a
// reserved-char id must never split the path or leak into the query string.
describe("driveConfig encodes config fileId in download URL (getAppConfig mirror)", () => {
  const weirdId = "abc/def?id x";
  const encodedId = encodeURIComponent(weirdId);

  beforeEach(() => {
    mockedFetch.mockReset();
    vi.clearAllMocks();
  });

  it("getAppConfig downloads the config at an encoded path segment", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        makeJsonResponse(200, { files: [{ id: weirdId }] }),
      ) // search finds existing config
      .mockResolvedValueOnce(makeJsonResponse(200, { ok: true })); // alt=media download

    await expect(getAppConfig("tok-1")).resolves.toEqual({ ok: true });

    expect(fetchCallAt(0)[0]).toContain("spaces=appDataFolder");
    expect(fetchCallAt(1)[0]).toBe(
      `https://www.googleapis.com/drive/v3/files/${encodedId}?alt=media`,
    );
  });
});
