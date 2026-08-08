import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  DRIVE_COOLDOWN_MS,
  DRIVE_FAILURE_WINDOW_MS,
  DriveRangeTokenizer,
  RangeFetchNetworkError,
  RangeNotSupportedError,
  SizeUnknownError,
  resetDriveCircuitBreakerForTests,
} from "./driveRangeTokenizer";
import * as errorLogModule from "./errorLog";

type FetchCall = { url: string; range: string | null };

function urlName(url: RequestInfo | URL): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return "(Request)";
}

function installVirtualFile(
  size: number,
  byteAt: (i: number) => number,
  statuses?: Array<number>,
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
    const status =
      statuses && statuses.length > 0
        ? (statuses[Math.min(statusCursor++, statuses.length - 1)] ?? 206)
        : 206;
    if (status !== 206) {
      active -= 1;
      return {
        status,
        ok: status >= 200 && status < 300,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
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

  it("gives up after 2 retries and reports the last error", async () => {
    const vf = installVirtualFile(1000, (i) => i % 256, [500, 500, 500]);
    const tz = new DriveRangeTokenizer("f1", 1000);
    await expect(tz.readRange(0, 8)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
    expect(vf.calls).toHaveLength(3);
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

  describe("Drive throttle circuit breaker (Fix H)", () => {
    it("opens the circuit after 3 consecutive failures and fails fast without fetching", async () => {
      vi.useFakeTimers();
      const captureSpy = vi
        .spyOn(errorLogModule, "captureError")
        .mockResolvedValue();
      const mock = timeoutMock();
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      await settleWithTimers(tz.readRange(0, 8)); // 2 failures (timeout + retry)
      await settleWithTimers(tz.readRange(0, 8)); // 1 more failure -> circuit opens
      const fastFail = await settleWithTimers(tz.readRange(0, 8));

      expect(mock).toHaveBeenCalledTimes(3); // NO 4th fetch while open
      expect(fastFail).toBeInstanceOf(RangeFetchNetworkError);
      if (fastFail instanceof RangeFetchNetworkError) {
        expect(fastFail.kind).toBe("timeout");
        expect(fastFail.message).toContain("drive-throttle-circuit-open");
      }
      expect(captureSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "driveRangeTokenizer",
          message: expect.stringContaining(
            "range-fetch-circuit-open",
          ) as unknown as string,
        }),
      );
    });

    it("resumes fetching after the cooldown window elapses", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const mock = vi.fn(() => {
        calls += 1;
        if (calls <= 3) {
          return Promise.reject(
            new DOMException("The operation timed out", "TimeoutError"),
          );
        }
        return Promise.resolve({
          status: 206,
          ok: true,
          arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer),
        });
      });
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      await settleWithTimers(tz.readRange(0, 8)); // 2 failures
      await settleWithTimers(tz.readRange(0, 8)); // 1 failure -> open
      await settleWithTimers(tz.readRange(0, 8)); // fail fast (no fetch)
      expect(mock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(DRIVE_COOLDOWN_MS + 1_000);
      const data = await tz.readRange(0, 8);
      expect(data).toHaveLength(8);
      expect(mock).toHaveBeenCalledTimes(4);
    });

    it("keeps fetching when failures stay below the threshold (normal path guard)", async () => {
      vi.useFakeTimers();
      const mock = vi
        .fn()
        .mockRejectedValueOnce(
          new DOMException("The operation timed out", "TimeoutError"),
        )
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

      await settleWithTimers(tz.readRange(0, 8)); // 2 failures -> throws
      const data = await tz.readRange(0, 8); // below threshold -> fetches fine
      expect(data).toHaveLength(8);
      expect(mock).toHaveBeenCalledTimes(3);
    });

    it("ignores failures older than the failure window (sliding window)", async () => {
      vi.useFakeTimers();
      const mock = timeoutMock();
      vi.stubGlobal("fetch", mock);
      const tz = new DriveRangeTokenizer("f1", 1000);

      await settleWithTimers(tz.readRange(0, 8)); // 2 failures
      await vi.advanceTimersByTimeAsync(DRIVE_FAILURE_WINDOW_MS + 1_000);
      await settleWithTimers(tz.readRange(0, 8)); // 2 fresh failures again

      expect(mock).toHaveBeenCalledTimes(4); // never opened: window expired
    });
  });
});
