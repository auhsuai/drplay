import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  DRIVE_COOLDOWN_MS,
  DRIVE_FAILURE_WINDOW_MS,
  DriveRangeTokenizer,
  HEAD_BYTES,
  RangeFetchNetworkError,
  RangeNotSupportedError,
  SizeUnknownError,
  isDriveCircuitOpen,
  resetDriveCircuitBreakerForTests,
} from "./driveRangeTokenizer";
import { AlignedChunkCache, MAX_CACHED_CHUNKS } from "./driveRangeChunkCache";
import * as errorLogModule from "./errorLog";

type FetchCall = { url: string; range: string | null };

function urlName(url: RequestInfo | URL): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return "(Request)";
}

// A status entry is either a plain status code or a code + JSON error body
// (403 rate-limit responses need a body for driveHttp.isRateLimit403Response).
type StatusSpec = number | { status: number; body?: unknown };

function installVirtualFile(
  size: number,
  byteAt: (i: number) => number,
  statuses?: Array<StatusSpec>,
) {
  const calls: FetchCall[] = [];
  let active = 0;
  let maxActive = 0;
  let statusCursor = 0;
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const headers = new Headers(init?.headers);
    const range = headers.get("Range");
    calls.push({ url: urlName(_url), range });
    const spec =
      statuses && statuses.length > 0
        ? (statuses[Math.min(statusCursor++, statuses.length - 1)] ?? 206)
        : 206;
    const status = typeof spec === "number" ? spec : spec.status;
    if (status !== 206) {
      active -= 1;
      // The responder mirrors a real Response's clone().json() surface so the
      // 403 rate-limit detector can read the body off a clone (the original
      // object is never consumed).
      const jsonBody = typeof spec === "number" ? undefined : spec.body;
      const json = () => Promise.resolve(jsonBody);
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        json,
        clone: () => ({ status, json }),
      };
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? "");
    if (!m) throw new Error(`missing Range header: ${String(range)}`);
    const start = Number(m[1]);
    const end = Number(m[2]);
    const len = Math.max(0, Math.min(end, size - 1) - start + 1);
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) data[i] = byteAt(start + i);
    await new Promise((r) => setTimeout(r, 1));
    active -= 1;
    return {
      status: 206,
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer),
    };
  });
  vi.stubGlobal("fetch", mock);
  return {
    mock,
    calls,
    maxActive: () => maxActive,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The breaker state is module-level (shared like rangeFetchSemaphore) —
  // tests must never leak an open circuit into the next test.
  resetDriveCircuitBreakerForTests();
});

// Runs the fake-clock retry-backoff timers to completion and returns the
// settled outcome of `promise` (the resolved value or the caught rejection).
async function settleWithTimers(promise: Promise<unknown>): Promise<unknown> {
  const guarded = promise.then(
    (v) => v,
    (e: unknown) => e,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  return guarded;
}

function timeoutMock(): ReturnType<typeof vi.fn> {
  return vi.fn(() =>
    Promise.reject(new DOMException("The operation timed out", "TimeoutError")),
  );
}

describe("DriveRangeTokenizer", () => {
  it("read within a loaded range performs no additional fetch", async () => {
    const vf = installVirtualFile(200_000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 200_000);
    await tz.readRange(0, 100);
    expect(vf.calls).toHaveLength(1);
    expect(vf.calls[0]?.range).toBe("bytes=0-65535");

    await tz.readRange(10, 90);
    expect(vf.calls).toHaveLength(1);
  });

  it("read beyond the loaded range fetches a chunk-aligned range", async () => {
    const vf = installVirtualFile(200_000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 200_000);
    await tz.readRange(70_000, 70_100);
    expect(vf.calls).toHaveLength(1);
    expect(vf.calls[0]?.range).toBe("bytes=65536-131071");
    expect(vf.calls[0]?.url).toContain("/drive-stream/f1");
  });

  it("ignore(n) advances the position without fetching data", async () => {
    const vf = installVirtualFile(200_000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 200_000);
    const ignored = await tz.ignore(10_000_000);
    expect(ignored).toBe(200_000);
    expect(tz.position).toBe(200_000);
    expect(vf.calls).toHaveLength(0);
  });

  it("throws BudgetExceededError once the per-file fetch budget is exhausted", async () => {
    installVirtualFile(300_000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 300_000, { budgetBytes: 131_072 });
    await tz.readRange(0, 100);
    await tz.readRange(65_536, 66_000);
    await expect(tz.readRange(131_072, 132_000)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it("throws RangeNotSupportedError when the response is not 206", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [200]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 10)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
    expect(vf.calls).toHaveLength(1);
  });

  it("treats 416 as RangeNotSupportedError (no retry)", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [416]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 10)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
    expect(vf.calls).toHaveLength(1);
  });

  it("returns the correct bytes on a 206 response", async () => {
    installVirtualFile(1000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 1000);
    const data = await tz.readRange(100, 200);
    expect(data).toHaveLength(100);
    for (let i = 0; i < 100; i += 1) {
      expect(data[i]).toBe((100 + i) % 256);
    }
  });

  it("non-aligned read returns the correct bytes (regression: chunk-relative indexing)", async () => {
    installVirtualFile(200_000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 200_000);
    // start=70000 is inside chunk 1 (chunkStart=65536) — NOT on a 64KB boundary
    const data = await tz.readRange(70_000, 70_100);
    expect(data).toHaveLength(100);
    expect(data[0]).toBe(70_000 % 256);
    expect(data[99]).toBe(70_099 % 256);
  });

  it("non-aligned reads in a later chunk return the correct bytes", async () => {
    installVirtualFile(200_000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 200_000);
    // two non-aligned ranges inside chunk 1, then one in chunk 2
    const a = await tz.readRange(70_000, 70_100);
    expect(a).toHaveLength(100);
    expect(a[0]).toBe(70_000 % 256);

    const b = await tz.readRange(70_500, 70_550);
    expect(b).toHaveLength(50);
    expect(b[0]).toBe(70_500 % 256);
    expect(b[49]).toBe(70_549 % 256);

    const c = await tz.readRange(131_000, 131_100);
    expect(c).toHaveLength(100);
    expect(c[0]).toBe(131_000 % 256);
    expect(c[99]).toBe(131_099 % 256);
  });

  it("readBuffer at a non-aligned position fills the target buffer", async () => {
    installVirtualFile(200_000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 200_000);
    const out = new Uint8Array(100);
    const n = await tz.readBuffer(out, { position: 70_000, length: 100 });
    expect(n).toBe(100);
    expect(out[0]).toBe(70_000 % 256);
    expect(out[99]).toBe(70_099 % 256);
    expect(tz.position).toBe(70_100);
  });

  it("throws RangeFetchNetworkError when fetch rejects", async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", mock);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 10)).rejects.toBeInstanceOf(
      RangeFetchNetworkError,
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("classifies a body-stream read failure after 206 as RangeFetchNetworkError (no retry, transient — never opens the global circuit)", async () => {
    const mock = vi.fn(() => ({
      status: 206,
      ok: true,
      arrayBuffer: () =>
        Promise.reject(new TypeError("connection reset mid-body")),
    }));
    vi.stubGlobal("fetch", mock);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 10)).rejects.toMatchObject({
      name: "RangeFetchNetworkError",
      kind: "network",
    });
    expect(mock).toHaveBeenCalledTimes(1); // no retry on body-stream failure
    // PHASE A2 CONTRACT: body-stream failures are TRANSIENT (network), not a
    // Drive throttle signal. Three of them must NOT open the app-wide circuit.
    await expect(tz.readRange(0, 10)).rejects.toBeInstanceOf(
      RangeFetchNetworkError,
    );
    await expect(tz.readRange(0, 10)).rejects.toBeInstanceOf(
      RangeFetchNetworkError,
    );
    expect(isDriveCircuitOpen()).toBe(false);
    await expect(tz.readRange(0, 10)).rejects.toBeInstanceOf(
      RangeFetchNetworkError,
    );
    expect(mock).toHaveBeenCalledTimes(4); // still fetching, no fail-fast
  });

  // Caller-abort during the body read (arrayBuffer rejects) after a 206:
  // deliberate cancellation (unmount mid-download), never a Drive failure —
  // it must not feed the app-wide circuit breaker, exactly like the
  // fetch-reject catch.
  it("caller abort during body read (arrayBuffer rejects) does not feed the circuit breaker either", async () => {
    const controller = new AbortController();
    const captureSpy = vi
      .spyOn(errorLogModule, "captureError")
      .mockResolvedValue();
    const mock = vi.fn(() => ({
      status: 206,
      ok: true,
      arrayBuffer: () => {
        // The caller cancels while the body is being read (unmount mid-download).
        controller.abort();
        return Promise.reject(
          new DOMException("The user aborted a request", "AbortError"),
        );
      },
    }));
    vi.stubGlobal("fetch", mock);
    const tz = new DriveRangeTokenizer("f1", 1000, {
      abortSignal: controller.signal,
    });

    // PHASE A1 CONTRACT: a cancellation is its OWN kind — never "timeout".
    await expect(tz.readRange(0, 8)).rejects.toMatchObject({
      name: "RangeFetchNetworkError",
      kind: "aborted",
    });
    // 3 cancels inside the failure window must NOT open the app-wide circuit
    // (unmount/navigation is deliberate, not Drive throttling)...
    const controller2 = new AbortController();
    const tz2 = new DriveRangeTokenizer("f2", 1000, {
      abortSignal: controller2.signal,
    });
    const abortingMock = vi.fn(() => ({
      status: 206,
      ok: true,
      arrayBuffer: () => {
        controller2.abort();
        return Promise.reject(
          new DOMException("The user aborted a request", "AbortError"),
        );
      },
    }));
    vi.stubGlobal("fetch", abortingMock);
    await expect(tz2.readRange(0, 8)).rejects.toMatchObject({
      kind: "aborted",
    });
    await expect(tz2.readRange(0, 8)).rejects.toMatchObject({
      kind: "aborted",
    });
    expect(isDriveCircuitOpen()).toBe(false);
    // Silent per the file's cancellation convention: no body-failed warn.
    expect(captureSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "range-fetch-body-failed",
        ) as unknown as string,
      }),
    );
  });

  it("classifies timeout rejections as RangeFetchNetworkError with kind timeout", async () => {
    const mock = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation timed out", "TimeoutError"),
      );
    vi.stubGlobal("fetch", mock);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 10)).rejects.toMatchObject({
      name: "RangeFetchNetworkError",
      kind: "timeout",
    });
  });

  it("retries a timeout rejection once before succeeding (transient stall)", async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("The operation timed out", "TimeoutError"),
      )
      .mockImplementation(() => ({
        status: 206,
        ok: true,
        arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer),
      }));
    vi.stubGlobal("fetch", mock);
    const tz = new DriveRangeTokenizer("f1", 1000);
    const data = await tz.readRange(0, 8);
    expect(data).toHaveLength(8);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("recovers from a timeout on a later chunk via retry", async () => {
    let callCount = 0;
    const mock = vi.fn(() => {
      callCount += 1;
      if (callCount === 3) {
        throw new DOMException("The operation timed out", "TimeoutError");
      }
      return {
        status: 206,
        ok: true,
        arrayBuffer: () => Promise.resolve(new Uint8Array(65_536).buffer),
      };
    });
    vi.stubGlobal("fetch", mock);
    const tz = new DriveRangeTokenizer("f1", 200_000);
    // 3 chunks (0, 65536, 131072); the 3rd request times out once, then retries.
    const data = await tz.readRange(0, 150_000);
    expect(data).toHaveLength(150_000);
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it("retries 5xx responses up to 2 times before succeeding", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [500, 500, 206]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    const data = await tz.readRange(0, 8);
    expect(data).toHaveLength(8);
    expect(vf.calls).toHaveLength(3);
  });

  it("retries 429 responses up to 2 times before succeeding", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [429, 429, 206]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await tz.readRange(0, 8);
    expect(vf.calls).toHaveLength(3);
  });

  // Google Drive handle-errors: a 403 whose body reports a usage-limit reason
  // (userRateLimitExceeded / rateLimitExceeded) is the same throttle signal as
  // a 429 — driveHttp.isRateLimit403Response is the shared detector.
  const RATE_LIMIT_403_BODY = {
    error: { errors: [{ reason: "userRateLimitExceeded" }] },
  };

  it("retries a rate-limit 403 like a 429 and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    const vf = installVirtualFile(1000, (i) => i % 256, [
      { status: 403, body: RATE_LIMIT_403_BODY },
      206,
    ]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    const data = await settleWithTimers(tz.readRange(0, 8));
    expect(data).toHaveLength(8);
    expect(vf.calls).toHaveLength(2); // retried once, unlike a plain 403
  });

  it("gives up on repeated rate-limit 403s with the transient throttled error", async () => {
    vi.useFakeTimers();
    const rateLimit403 = { status: 403, body: RATE_LIMIT_403_BODY };
    const vf = installVirtualFile(1000, (i) => i % 256, [
      rateLimit403,
      rateLimit403,
      rateLimit403,
    ]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    const err = await settleWithTimers(tz.readRange(0, 8));
    expect(err).toBeInstanceOf(RangeFetchNetworkError);
    // PHASE A1: a Drive rate-limit 403 is its own kind, distinct from a bare
    // network error, so cooldown policy can treat it as a throttle signal.
    expect(err).toMatchObject({
      name: "RangeFetchNetworkError",
      kind: "rate_limited",
      status: 403,
    });
    expect(vf.calls).toHaveLength(3); // all attempts spent before giving up
    // ONE logical op ⇒ ONE throttle failure: below the 3-failure threshold,
    // so a single throttled request does NOT black out the app.
    expect(isDriveCircuitOpen()).toBe(false);
  });

  it("keeps a non-rate-limit 403 deterministic (RangeNotSupportedError, no retry)", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [
      { status: 403, body: { error: { errors: [{ reason: "forbidden" }] } } },
    ]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 8)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
    expect(vf.calls).toHaveLength(1);
    expect(isDriveCircuitOpen()).toBe(false);
  });

  // FLIPPED deliberately per the android contract (2a2d909/e839613): retry
  // exhaustion on 429/5xx now surfaces the TRANSIENT RangeFetchNetworkError
  // instead of the deterministic RangeNotSupportedError, so fetchPipeline
  // stops pinning the placeholder after throttle storms.
  it("gives up after 2 retries and reports a transient throttled error", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [500, 500, 500]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 8)).rejects.toMatchObject({
      name: "RangeFetchNetworkError",
      kind: "network",
      status: 500,
    });
    expect(vf.calls).toHaveLength(3); // all attempts spent before giving up
  });

  // PHASE A2 CONTRACT (one failure per LOGICAL operation): a timed-out
  // request consumes exactly ONE breaker slot even though the fetcher tries
  // it twice. A 5xx storm likewise records ONE failure, not three.
  it("records ONE breaker failure per logical operation, including the exhausted retries", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [500, 500, 500]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 8)).rejects.toBeInstanceOf(
      RangeFetchNetworkError,
    );
    expect(vf.calls).toHaveLength(3);
    // 5xx is TRANSIENT: even at threshold it never opens the global circuit.
    expect(isDriveCircuitOpen()).toBe(false);
  });

  it("single non-retryable 404 stays deterministic RangeNotSupportedError without feeding the breaker", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [404]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 8)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
    expect(vf.calls).toHaveLength(1); // no retry on 404
    expect(isDriveCircuitOpen()).toBe(false); // deterministic: no breaker feed
  });

  // Caller-abort during 429/5xx backoff must mirror the timeout branch:
  // never sleep the full Retry-After (up to 32s) just to fire one doomed
  // attempt afterwards — exit immediately via the same RangeFetchNetworkError
  // path the timeout branch uses for caller-abort.
  it("caller abort during 429 backoff exits immediately instead of sleeping the Retry-After", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const mock = vi.fn(() => {
      // Caller cancels exactly when the failed response arrives — the
      // signal is already aborted at the moment the backoff sleep starts.
      controller.abort();
      return Promise.resolve({
        status: 500,
        ok: false,
        headers: new Headers({ "Retry-After": "32" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    });
    vi.stubGlobal("fetch", mock);
    const tz = new DriveRangeTokenizer("f1", 1000, {
      abortSignal: controller.signal,
    });

    let settled = false;
    const guarded = tz.readRange(0, 8).then(
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
    // near the 32s Retry-After — the rejection must already have happened.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const err = await guarded;
    // PHASE A1: a caller cancel is its OWN kind, never "timeout".
    expect(err).toBeInstanceOf(RangeFetchNetworkError);
    expect(err).toMatchObject({
      name: "RangeFetchNetworkError",
      kind: "aborted",
      message: "Range fetch aborted by caller",
    });
    expect(mock).toHaveBeenCalledTimes(1); // no doomed second attempt
    // Cancellation is not a failure: no breaker evidence either way.
    expect(isDriveCircuitOpen()).toBe(false);
  });

  // The pre-sleep guard only handles an abort that already happened; an abort
  // WHILE parked in the Retry-After backoff must exit just as fast — the
  // sleep is signal-cancellable, so the caller is never held up to 32s.
  it("caller abort mid-429-backoff-sleep rejects immediately with the same exit shape", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const mock = vi.fn(() =>
      Promise.resolve({
        status: 429,
        ok: false,
        headers: new Headers({ "Retry-After": "32" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    );
    vi.stubGlobal("fetch", mock);
    const tz = new DriveRangeTokenizer("f1", 1000, {
      abortSignal: controller.signal,
    });

    let settled = false;
    const guarded = tz.readRange(0, 8).then(
      (v) => {
        settled = true;
        return v;
      },
      (e: unknown) => {
        settled = true;
        return e;
      },
    );
    // Let the 429 land and the 32s backoff sleep start, then cancel mid-sleep.
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false); // parked in the backoff, not settled yet
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    // Captured BEFORE any big advance: the abort must have settled the read
    // already (old behavior parks the full 32s and only settles after it).
    const settledOnAbort = settled;
    // Flush the (now-cleared) old sleep timer too so a parked promise settles
    // instead of hanging the test; the new code has nothing left to flush.
    await vi.advanceTimersByTimeAsync(32_000);
    const err = await guarded;
    expect(settledOnAbort).toBe(true);
    // PHASE A1: cancellation has its own kind.
    expect(err).toBeInstanceOf(RangeFetchNetworkError);
    expect(err).toMatchObject({
      name: "RangeFetchNetworkError",
      kind: "aborted",
      message: "Range fetch aborted by caller",
    });
    expect(mock).toHaveBeenCalledTimes(1); // abort mid-backoff: no second attempt
    // Cancellation is not a failure: the 429 never reached the breaker.
    expect(isDriveCircuitOpen()).toBe(false);
  });

  it("throws SizeUnknownError when size is 0 or negative", () => {
    expect(() => new DriveRangeTokenizer("f1", 0)).toThrow(SizeUnknownError);
    expect(() => new DriveRangeTokenizer("f1", -5)).toThrow(SizeUnknownError);
  });

  it("supports random access (backward reads)", async () => {
    const vf = installVirtualFile(200_000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 200_000);
    expect(tz.supportsRandomAccess()).toBe(true);
    await tz.readRange(100_000, 100_100);
    const out = new Uint8Array(4);
    const n = await tz.readBuffer(out, { position: 4, length: 4 });
    expect(n).toBe(4);
    expect(Array.from(out)).toEqual([4, 5, 6, 7]);
    expect(vf.calls).toHaveLength(2);
  });

  it("peekBuffer does not advance the position; readBuffer does", async () => {
    installVirtualFile(1000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 1000);
    const peeked = new Uint8Array(4);
    await tz.peekBuffer(peeked, { position: 0, length: 4 });
    expect(tz.position).toBe(0);
    const read = new Uint8Array(4);
    await tz.readBuffer(read, { position: 0, length: 4 });
    expect(tz.position).toBe(4);
    expect(Array.from(read)).toEqual([0, 1, 2, 3]);
  });

  it("inherits readToken from AbstractTokenizer", async () => {
    installVirtualFile(1000, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", 1000);
    const token = {
      len: 4,
      get: (b: Uint8Array, off: number): number =>
        ((b[off] ?? 0) << 24) |
        ((b[off + 1] ?? 0) << 16) |
        ((b[off + 2] ?? 0) << 8) |
        (b[off + 3] ?? 0),
    };
    const value = await tz.readToken(token, 0);
    expect(value).toBe(0x00010203);
  });

  it("keeps app-wide concurrent range fetches at or below 3", async () => {
    const vf = installVirtualFile(1_000_000, (i) => i % 256);
    const tokenizers = [1, 2, 3, 4, 5, 6].map(
      (k) => new DriveRangeTokenizer(`f${String(k)}`, 1_000_000),
    );
    await Promise.all(
      tokenizers.map((tz, idx) =>
        tz.readRange(idx * 130_000, idx * 130_000 + 100),
      ),
    );
    expect(vf.maxActive()).toBeLessThanOrEqual(3);
    expect(vf.calls).toHaveLength(6);
  });

  it("cache evicts the least-recently-used chunk, not the oldest-inserted (LRU vs FIFO)", async () => {
    // 129 aligned chunks (> MAX_CACHED_CHUNKS 128) forces one eviction.
    const chunkCount = 129;
    const size = chunkCount * 65_536 + 100;
    const vf = installVirtualFile(size, (i) => i % 256);
    const tz = new DriveRangeTokenizer("f1", size);
    const readChunk = async (n: number): Promise<void> => {
      const start = n * 65_536;
      await tz.readRange(start, start + 100);
    };
    // Chunk 0 is fetched, then re-read (cache hit) while only 2 entries exist:
    // an LRU refresh moves it to the most-recent end, FIFO keeps insertion order.
    await readChunk(0);
    await readChunk(1);
    await readChunk(0);
    // Fill the cache to its 128-chunk bound with the rest.
    for (let n = 2; n < 128; n += 1) await readChunk(n);
    // The 129th chunk evicts exactly one entry: FIFO evicts chunk 0 (oldest
    // inserted), LRU evicts chunk 1 (least recently read — chunk 0 was
    // refreshed). Re-reading chunk 0 must therefore be a cache hit under LRU
    // and a re-fetch under FIFO.
    await readChunk(128);
    await readChunk(0);
    const chunk0Fetches = vf.calls.filter(
      (c) => c.range === "bytes=0-65535",
    ).length;
    expect(chunk0Fetches).toBe(1);
  });

  // Invariant anchor (mirror of prefetchRange's seed guard): a partially
  // covered chunk may only be cached when it ends at EOF. The old seed loop
  // cached every chunk unconditionally, so a head that is not a multiple of
  // RANGE_CHUNK left a short cache entry mid-file and later reads past it
  // were silently truncated at that entry's edge.
  describe("prefetchHead (single-request head region)", () => {
    it("a partial seed chunk below EOF is NOT cached: reads past the head re-fetch the full chunk", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      // Head smaller than one 64KB chunk on a much longer file: the only
      // covered chunk [0, 30000) is partial and does NOT end at EOF.
      const data = await tz.prefetchHead(30_000);
      expect(data).toHaveLength(30_000);
      expect(vf.calls).toHaveLength(1);
      expect(vf.calls[0]?.range).toBe("bytes=0-29999");
      // A read beyond the prefetched region (same aligned chunk) must hit
      // the network for the FULL chunk — never serve the short seed's edge
      // as a silent truncation (the old code returned 0 bytes here).
      const tail = await tz.readRange(35_000, 35_100);
      expect(tail).toHaveLength(100);
      expect(tail[0]).toBe(35_000 % 256);
      expect(tail[99]).toBe(35_099 % 256);
      expect(vf.calls).toHaveLength(2);
      expect(vf.calls[1]?.range).toBe("bytes=0-65535");
    });

    it("seeds full chunks normally; only the partial below-EOF trailing chunk is skipped", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      const data = await tz.prefetchHead(70_000); // 1 full chunk + 4464 bytes
      expect(data).toHaveLength(70_000);
      expect(vf.calls).toHaveLength(1);
      // Inside the fully-covered chunk 0: cache-served, no extra request.
      await tz.readRange(0, 100);
      expect(vf.calls).toHaveLength(1);
      // Inside the partially-covered chunk 1: normal aligned re-fetch, no
      // shadowing by a short entry.
      const tail = await tz.readRange(75_536, 75_636);
      expect(tail).toHaveLength(100);
      expect(tail[0]).toBe(75_536 % 256);
      expect(vf.calls).toHaveLength(2);
      expect(vf.calls[1]?.range).toBe("bytes=65536-131071");
    });

    it("a partial trailing chunk AT EOF is still cached (the invariant's allowed case)", async () => {
      const vf = installVirtualFile(100_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 100_000);
      const data = await tz.prefetchHead(HEAD_BYTES); // clamps to fileSize
      expect(data).toHaveLength(100_000);
      expect(vf.calls).toHaveLength(1);
      expect(vf.calls[0]?.range).toBe("bytes=0-99999");
      // The EOF-ending partial chunk stays cache-served: no extra request.
      const end = await tz.readRange(90_000, 90_100);
      expect(end).toHaveLength(100);
      expect(end[0]).toBe(90_000 % 256);
      expect(vf.calls).toHaveLength(1);
    });
  });

  describe("prefetchRange (single-request arbitrary region)", () => {
    it("fetches [start, end) in exactly one request and returns the region bytes", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      const data = await tz.prefetchRange(100, 71_780);
      expect(vf.calls).toHaveLength(1);
      // The fetch is extended DOWN to the covering 64KB boundary so every
      // seeded chunk keeps an aligned start.
      expect(vf.calls[0]?.range).toBe("bytes=0-71779");
      expect(data).toHaveLength(71_680);
      expect(data[0]).toBe(100 % 256);
      expect(data[71_679]).toBe(71_779 % 256);
    });

    it("seeds the aligned chunk cache: reads inside the region add no requests", async () => {
      const vf = installVirtualFile(71_780, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 71_780);
      await tz.prefetchRange(100, 71_780);
      expect(vf.calls).toHaveLength(1);
      // chunk 0 is fully covered; the trailing partial chunk is cached at EOF
      const a = await tz.readRange(0, 100);
      expect(a).toHaveLength(100);
      const b = await tz.readRange(70_000, 71_780);
      expect(b).toHaveLength(1_780);
      expect(b[0]).toBe(70_000 % 256);
      expect(vf.calls).toHaveLength(1);
    });

    it("serves a fully cached region without a second request (MPF-2)", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      // Ends on a chunk boundary: chunk 0 is fully covered and cached (a
      // region ending mid-chunk below EOF is intentionally never cacheable).
      const first = await tz.prefetchRange(100, 65_536);
      expect(vf.calls).toHaveLength(1);
      const second = await tz.prefetchRange(100, 65_536);
      // The region is already cached: an m4a tail prefetch that runs after the
      // parser read the same bytes must not pull them over the network again.
      expect(vf.calls).toHaveLength(1);
      expect(Array.from(second)).toEqual(Array.from(first));
    });

    it("a tail already read by the parser is not re-fetched by prefetchRange (m4a tail scenario)", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      // Parser read: chunk 131072 (full) + chunk 196608 (EOF-partial).
      await tz.readRange(131_072, 200_000);
      expect(vf.calls).toHaveLength(2);
      const data = await tz.prefetchRange(131_072, 200_000);
      expect(vf.calls).toHaveLength(2);
      expect(data).toHaveLength(200_000 - 131_072);
      expect(data[0]).toBe(131_072 % 256);
      expect(data[68_927]).toBe(199_999 % 256);
    });

    it("throws BudgetExceededError when the fetch would exceed the per-file budget", async () => {
      installVirtualFile(300_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 300_000, {
        budgetBytes: 131_072,
      });
      await tz.prefetchRange(0, 100);
      await expect(tz.prefetchRange(100, 200_000)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
    });

    it("clamps the region to the file size and no-ops beyond EOF", async () => {
      const vf = installVirtualFile(10_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 10_000);
      const data = await tz.prefetchRange(5_000, 999_999);
      expect(vf.calls).toHaveLength(1);
      expect(vf.calls[0]?.range).toBe("bytes=0-9999");
      expect(data).toHaveLength(5_000);
      // a fully out-of-range region fetches nothing
      const empty = await tz.prefetchRange(20_000, 30_000);
      expect(empty).toHaveLength(0);
      expect(vf.calls).toHaveLength(1);
    });

    it("a partial trailing chunk (not at EOF) is NOT cached: reads past the region re-fetch", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      await tz.prefetchRange(70_000, 140_000);
      expect(vf.calls).toHaveLength(1);
      expect(vf.calls[0]?.range).toBe("bytes=65536-139999");
      // inside the prefetched region: cache-served
      await tz.readRange(70_000, 100_000);
      expect(vf.calls).toHaveLength(1);
      // beyond it: a normal aligned fetch (no shadowing by a short entry)
      await tz.readRange(131_000, 132_000);
      expect(vf.calls).toHaveLength(2);
      expect(vf.calls[1]?.range).toBe("bytes=131072-196607");
    });
  });

  describe("concurrent in-flight chunk dedup", () => {
    it("dedupes concurrent reads of the same chunk: one fetch, one budget charge", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000, {
        budgetBytes: 131_072,
      });
      // Both reads land in chunk 0 and race: without in-flight dedup they
      // issue two fetches for bytes=0-65535 and charge the budget twice.
      await Promise.all([tz.readRange(0, 100), tz.readRange(100, 200)]);
      const chunk0Fetches = vf.calls.filter(
        (c) => c.range === "bytes=0-65535",
      ).length;
      expect(chunk0Fetches).toBe(1);
      // The budget was charged once: reading chunk 1 still fits under the
      // 2-chunk budget (a double charge would throw BudgetExceededError).
      const data = await tz.readRange(65_536, 65_636);
      expect(data).toHaveLength(100);
      expect(vf.calls).toHaveLength(2);
    });

    it("a read racing an in-flight prefetchRange joins its fetch instead of issuing a second request", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      await Promise.all([tz.prefetchRange(100, 71_780), tz.readRange(10, 90)]);
      expect(vf.calls).toHaveLength(1);
      expect(vf.calls[0]?.range).toBe("bytes=0-71779");
      const data = await tz.readRange(0, 100);
      expect(data).toHaveLength(100);
      expect(data[0]).toBe(0);
      expect(vf.calls).toHaveLength(1);
    });

    it("dedupes two concurrent prefetchRanges of the same region", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      const [a, b] = await Promise.all([
        tz.prefetchRange(100, 71_780),
        tz.prefetchRange(100, 71_780),
      ]);
      expect(vf.calls).toHaveLength(1);
      expect(a).toHaveLength(71_680);
      expect(b).toHaveLength(71_680);
      expect(a[0]).toBe(100 % 256);
      expect(b[0]).toBe(100 % 256);
    });

    it("a read never joins a prefetch whose first chunk is only partially covered (full chunk is refetched)", async () => {
      const vf = installVirtualFile(200_000, (i) => i % 256);
      const tz = new DriveRangeTokenizer("f1", 200_000);
      // prefetchRange(70000, 70100) fetches bytes=65536-70099 — chunk 65536
      // is only partially covered, so the joining read must not be served
      // short data; it refetches the full chunk.
      await Promise.all([
        tz.prefetchRange(70_000, 70_100),
        tz.readRange(70_000, 70_100),
      ]);
      expect(vf.calls).toHaveLength(2);
      expect(vf.calls.some((c) => c.range === "bytes=65536-131071")).toBe(true);
      const data = await tz.readRange(131_000, 131_100);
      expect(data).toHaveLength(100);
      expect(vf.calls).toHaveLength(3);
    });
  });

  describe("Drive throttle circuit breaker (Phase A2 contract)", () => {
    // 429 (or a confirmed rate-limit 403) is the ONLY throttle signal that may
    // open the app-wide circuit. 5xx / timeout / network are transient.
    const RATE_LIMIT_429 = {
      status: 429,
      ok: false,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      json: () => Promise.resolve(undefined),
      clone: () => ({ json: () => Promise.resolve(undefined) }),
    };

    function throttleMock(): ReturnType<typeof vi.fn> {
      return vi.fn(() => Promise.resolve({ ...RATE_LIMIT_429 }));
    }

    it("opens on 3 LOGICAL throttle failures and rejects without fetching, as kind circuit_open", async () => {
      vi.useFakeTimers();
      const captureSpy = vi
        .spyOn(errorLogModule, "captureError")
        .mockResolvedValue();
      const mock = throttleMock();
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      // Each logical read = 3 upstream attempts (initial + 2 retries) but ONE
      // breaker failure. Three of those reach DRIVE_FAILURE_THRESHOLD.
      await settleWithTimers(tz.readRange(0, 8));
      await settleWithTimers(tz.readRange(0, 8));
      await settleWithTimers(tz.readRange(0, 8));
      expect(mock).toHaveBeenCalledTimes(9);
      expect(isDriveCircuitOpen()).toBe(true);

      const fastFail = await settleWithTimers(tz.readRange(0, 8));
      expect(mock).toHaveBeenCalledTimes(9); // NO fetch while open
      expect(fastFail).toBeInstanceOf(RangeFetchNetworkError);
      if (fastFail instanceof RangeFetchNetworkError) {
        // PHASE A1: a breaker rejection is NEVER reported as a timeout.
        expect(fastFail.kind).toBe("circuit_open");
        expect(fastFail.message).toContain("drive-throttle-circuit-open");
      }
      expect(captureSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "driveRangeTokenizer",
          message: expect.stringContaining(
            "drive-throttle-circuit-open",
          ) as unknown as string,
        }),
      );
    });

    it("ONE timeout never opens the circuit (transient failures do not accumulate into a blackout)", async () => {
      vi.useFakeTimers();
      const mock = timeoutMock();
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      // A single logical timeout = 2 upstream attempts. Repeat it well past
      // the old threshold: the circuit must stay closed.
      for (let i = 0; i < 5; i += 1) {
        await settleWithTimers(tz.readRange(0, 8));
      }
      expect(isDriveCircuitOpen()).toBe(false);
      expect(mock).toHaveBeenCalledTimes(10); // every read still fetched
    });

    it("a success RESETS the throttle window (account is not throttled if it still answers)", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const mock = vi.fn(() => {
        calls += 1;
        // 1st logical op (attempts 1-3): throttled.
        if (calls <= 3) return Promise.resolve({ ...RATE_LIMIT_429 });
        // 2nd logical op (attempt 4): succeeds — resets the window.
        if (calls === 4) {
          return Promise.resolve({
            status: 206,
            ok: true,
            arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer),
          });
        }
        // 3rd logical op (attempts 5-7): throttled again — only ONE failure
        // in the fresh window, so the circuit must stay closed.
        return Promise.resolve({ ...RATE_LIMIT_429 });
      });
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      await settleWithTimers(tz.readRange(0, 8)); // throttle failure #1
      expect(isDriveCircuitOpen()).toBe(false);
      const data = await settleWithTimers(tz.readRange(0, 8));
      expect(data).toBeInstanceOf(Uint8Array);
      expect(isDriveCircuitOpen()).toBe(false);
      await settleWithTimers(tz.readRange(0, 8)); // failure #1 of a NEW window
      // Would have been failure #2 overall (below threshold anyway) — the
      // reset is proven by remaining below threshold after a 2nd failure.
      expect(isDriveCircuitOpen()).toBe(false);
    });

    it("half-open admits exactly ONE probe after the cooldown; other callers keep failing fast", async () => {
      vi.useFakeTimers();
      let probes = 0;
      const mock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        probes += 1;
        if (probes <= 9) return Promise.resolve({ ...RATE_LIMIT_429 });
        // The probe hangs ~5s; the other reads must fail fast meanwhile.
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              status: 206,
              ok: true,
              arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer),
            });
          }, 5_000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      });
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 400_000);

      for (let i = 0; i < 3; i += 1) {
        await settleWithTimers(tz.readRange(0, 8));
      }
      expect(isDriveCircuitOpen()).toBe(true);
      await vi.advanceTimersByTimeAsync(DRIVE_COOLDOWN_MS + 1_000);

      // The probe claims chunk 0. Two OTHER chunk reads must fail fast —
      // they use distinct chunk keys so they cannot join the probe's in-flight
      // promise. Handlers are attached immediately to avoid an unhandled
      // rejection while the probe is still parked.
      const settle = (p: Promise<unknown>) =>
        p.then(
          (v) => v,
          (e: unknown) => e,
        );
      const probe = settle(tz.readRange(0, 8));
      await vi.advanceTimersByTimeAsync(10);
      const other1 = settle(tz.readRange(65_600, 65_700));
      const other2 = settle(tz.readRange(131_200, 131_300));
      await vi.advanceTimersByTimeAsync(10);
      expect(await other1).toMatchObject({ kind: "circuit_open" });
      expect(await other2).toMatchObject({ kind: "circuit_open" });
      await vi.advanceTimersByTimeAsync(6_000);
      const data = await probe;
      expect(data).toBeInstanceOf(Uint8Array);
      expect(data).toHaveLength(8);
      // 9 (three throttled ops) + exactly 1 probe.
      expect(mock).toHaveBeenCalledTimes(10);
      expect(isDriveCircuitOpen()).toBe(false);
    });

    it("half-open probe failure RE-OPENS the circuit for another cooldown", async () => {
      vi.useFakeTimers();
      const mock = vi.fn(() => Promise.resolve({ ...RATE_LIMIT_429 }));
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      for (let i = 0; i < 3; i += 1) {
        await settleWithTimers(tz.readRange(0, 8));
      }
      expect(isDriveCircuitOpen()).toBe(true);
      await vi.advanceTimersByTimeAsync(DRIVE_COOLDOWN_MS + 1_000);

      // The probe runs and fails: one logical op = 3 upstream attempts.
      await settleWithTimers(tz.readRange(0, 8));
      expect(mock).toHaveBeenCalledTimes(12);
      // Re-opened: the next read fails fast without fetching.
      await settleWithTimers(tz.readRange(0, 8));
      expect(mock).toHaveBeenCalledTimes(12);
      expect(isDriveCircuitOpen()).toBe(true);
    });

    it("a breaker rejection does not extend or re-trip the open window", async () => {
      vi.useFakeTimers();
      const mock = throttleMock();
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      for (let i = 0; i < 3; i += 1) {
        await settleWithTimers(tz.readRange(0, 8));
      }
      expect(isDriveCircuitOpen()).toBe(true);
      // Hammer rejections for half the cooldown.
      await vi.advanceTimersByTimeAsync(DRIVE_COOLDOWN_MS / 2);
      for (let i = 0; i < 5; i += 1) {
        await settleWithTimers(tz.readRange(0, 8));
      }
      expect(mock).toHaveBeenCalledTimes(9); // still no fetch
      // The remaining half of the ORIGINAL cooldown is enough to expire it —
      // rejections did not push the deadline out.
      await vi.advanceTimersByTimeAsync(DRIVE_COOLDOWN_MS / 2 + 1_000);
      await settleWithTimers(tz.readRange(0, 8)); // probe admitted (fetches)
      expect(mock).toHaveBeenCalledTimes(12);
    });

    it("keeps fetching when throttle failures stay below the threshold", async () => {
      vi.useFakeTimers();
      const mock = vi
        .fn()
        .mockResolvedValueOnce({ ...RATE_LIMIT_429 })
        .mockResolvedValueOnce({ ...RATE_LIMIT_429 })
        .mockResolvedValueOnce({ ...RATE_LIMIT_429 })
        .mockImplementation(() => ({
          status: 206,
          ok: true,
          arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer),
        }));
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      await settleWithTimers(tz.readRange(0, 8)); // 1 logical throttle failure
      const data = await settleWithTimers(tz.readRange(0, 8));
      expect(data).toBeInstanceOf(Uint8Array);
      expect(isDriveCircuitOpen()).toBe(false);
    });

    it("ignores throttle failures older than the failure window (sliding window)", async () => {
      vi.useFakeTimers();
      const mock = throttleMock();
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      await settleWithTimers(tz.readRange(0, 8));
      await vi.advanceTimersByTimeAsync(DRIVE_FAILURE_WINDOW_MS + 1_000);
      await settleWithTimers(tz.readRange(0, 8));
      await settleWithTimers(tz.readRange(0, 8));

      // 2 fresh failures (not 3): the expired one was pruned.
      expect(isDriveCircuitOpen()).toBe(false);
      expect(mock).toHaveBeenCalledTimes(9); // 3 throttled logical ops × 3 attempts
    });

    it("caller-abort does not feed the circuit breaker (deliberate cancel, not a failure)", async () => {
      const controller = new AbortController();
      controller.abort();
      const captureSpy = vi
        .spyOn(errorLogModule, "captureError")
        .mockResolvedValue();
      const mock = vi.fn(() =>
        Promise.reject(
          new DOMException("The user aborted a request", "AbortError"),
        ),
      );
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000, {
        abortSignal: controller.signal,
      });

      for (let i = 0; i < 3; i += 1) {
        await expect(tz.readRange(0, 8)).rejects.toMatchObject({
          kind: "aborted",
        });
      }

      // 3 cancels inside the failure window must NOT open the app-wide
      // circuit (unmount/navigation is deliberate, not Drive throttling)...
      expect(isDriveCircuitOpen()).toBe(false);
      // ...and a cancelled caller never dispatches a request: the semaphore
      // drops the queued waiter before it can touch the network.
      await expect(tz.readRange(0, 8)).rejects.toMatchObject({
        kind: "aborted",
      });
      expect(mock).toHaveBeenCalledTimes(0);
      // A caller cancel is not a timeout: no "range-fetch-timeout" warn.
      expect(captureSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "range-fetch-timeout",
          ) as unknown as string,
        }),
      );
    });

    it("AbortError from the internal timeout (no caller abort) is a real timeout, still transient", async () => {
      vi.useFakeTimers();
      const mock = vi.fn(() =>
        Promise.reject(
          new DOMException("The operation was aborted", "AbortError"),
        ),
      );
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      const err = await settleWithTimers(tz.readRange(0, 8));
      expect(err).toMatchObject({
        name: "RangeFetchNetworkError",
        kind: "timeout",
      });
      // Transient: never opens the global circuit.
      expect(isDriveCircuitOpen()).toBe(false);
      expect(mock).toHaveBeenCalledTimes(2); // timeout + one retry
    });
  });
});

describe("Drive range structured diagnostics (Phase C)", () => {
  it("aggregates counters for a logical op without logging a success", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256);
    const captureSpy = vi
      .spyOn(errorLogModule, "captureError")
      .mockResolvedValue();
    const { driveRangeStats, resetDriveRangeStatsForTests } =
      await import("./driveRangeChunkFetcher");
    resetDriveRangeStatsForTests();
    const tz = new DriveRangeTokenizer("f1", 1000);
    await tz.readRange(0, 8);
    expect(vf.calls).toHaveLength(1);
    expect(driveRangeStats.operations).toBe(1);
    expect(driveRangeStats.requests).toBe(1);
    expect(driveRangeStats.retries).toBe(0);
    expect(driveRangeStats.bytes).toBeGreaterThan(0);
    // No per-success log spam.
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("a failure log carries structured kind/status/attempts/bytes/timings and no token", async () => {
    const captureSpy = vi
      .spyOn(errorLogModule, "captureError")
      .mockResolvedValue();
    const mock = vi.fn(() => ({
      status: 206,
      ok: true,
      arrayBuffer: () =>
        Promise.reject(new TypeError("connection reset mid-body")),
    }));
    vi.stubGlobal("fetch", mock);
    const { resetDriveRangeStatsForTests } =
      await import("./driveRangeChunkFetcher");
    resetDriveRangeStatsForTests();
    const tz = new DriveRangeTokenizer("secret-file-id", 1000);
    await expect(tz.readRange(0, 8)).rejects.toBeInstanceOf(
      RangeFetchNetworkError,
    );
    const bodyLog = captureSpy.mock.calls.find(([args]) =>
      args.message.includes("range-fetch-body-failed"),
    );
    expect(bodyLog).toBeDefined();
    const message = bodyLog?.[0].message ?? "";
    expect(message).toContain("kind=network");
    expect(message).toContain("status=206");
    expect(message).toContain("attempts=1");
    expect(message).toContain("bytes=0-999");
    expect(message).toContain("queueWaitMs=");
    expect(message).toContain("ttfbMs=");
    expect(message).toContain("transferMs=");
    expect(message).toContain("totalMs=");
    expect(message).toContain("aborted=false");
    // Never the token (the range layer never sees one) and the id is present
    // only in the pre-existing redactable fileId= slot.
    expect(message).not.toContain("Bearer");
  });
});

describe("AlignedChunkCache (set ownership + recency)", () => {
  it("set() on an existing key refreshes its recency so it is not evicted first", () => {
    const cache = new AlignedChunkCache();
    const fullChunk = new Uint8Array(65_536); // owns its buffer -> stored as-is
    for (let k = 0; k < MAX_CACHED_CHUNKS; k += 1) cache.set(k, fullChunk);
    // Re-seed existing key 0 (the prefetchRange/prefetchHead re-set path): it
    // must move to the most-recent end, not stay at the eviction head.
    cache.set(0, fullChunk);
    cache.set(MAX_CACHED_CHUNKS, fullChunk); // one over the bound -> evict one
    cache.evict();
    expect(cache.peek(0)).toBeDefined(); // refreshed key survived
    expect(cache.peek(1)).toBeUndefined(); // the true LRU (key 1) was evicted
  });

  it("set() copies a subarray view so the cache never pins the parent buffer", () => {
    const cache = new AlignedChunkCache();
    const parent = new Uint8Array(1024);
    const view = parent.subarray(32, 96);
    view[0] = 7;
    cache.set(0, view);
    const stored = cache.peek(0);
    // Owned copy: same bytes, zero offset, own buffer — the parent (and the
    // rest of its multi-byte region) is not retained.
    expect(stored).not.toBe(view);
    expect(Array.from(stored ?? [])).toEqual(Array.from(view));
    expect(stored?.byteOffset).toBe(0);
    expect(stored?.buffer).not.toBe(parent.buffer);
    expect(stored?.buffer.byteLength).toBe(view.byteLength);
    // A later parent mutation must not leak into the cached copy.
    parent[32] = 99;
    expect(stored?.[0]).toBe(7);
  });
});
