import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import {
  prefetchNextTrackAudio,
  clearNextTrackPrefetches,
  getPendingPrefetchCount,
} from "./nextTrackPrefetcher";

vi.mock("./errorLog", () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

import { captureError } from "./errorLog";

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface DeferredFetch {
  resolve: (response: Response) => void;
  reject: (err: unknown) => void;
}

function makeDeferredFetch(): {
  spy: MockInstance<typeof fetch>;
  deferreds: DeferredFetch[];
} {
  const deferreds: DeferredFetch[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    return new Promise<Response>((resolve, reject) => {
      deferreds.push({ resolve, reject });
    });
  });
  return { spy, deferreds };
}

describe("nextTrackPrefetcher LRU", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNextTrackPrefetches();
  });

  it("evicts the least-recently-used track when over capacity", () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    const urls = ["a", "b", "c", "d"].map((u) => `https://x/${u}`);
    urls.forEach((u) => {
      prefetchNextTrackAudio(u);
    });

    // 4 fetches attempted; capacity 3 -> oldest 'a' aborted exactly once
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the newer controller's entry when an evicted older fetch settles late", async () => {
    const { spy: fetchSpy, deferreds } = makeDeferredFetch();

    const urlX = "https://x/same";
    // Fetch A for urlX in flight (call #1)
    prefetchNextTrackAudio(urlX);
    // Fill to capacity MAX=3: {urlX(A), u1, u2}
    prefetchNextTrackAudio("https://x/u1"); // #2
    prefetchNextTrackAudio("https://x/u2"); // #3
    // 4th insert over capacity evicts the oldest == A (aborts it)
    prefetchNextTrackAudio("https://x/evictor"); // #4
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // Same tick: caller re-requests urlX -> fetch B created and stored (#5)
    prefetchNextTrackAudio(urlX);
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // A settles LATE, after B was already inserted into the map
    const fetchA = deferreds[0];
    if (fetchA === undefined) throw new Error("expected deferred for fetch A");
    fetchA.reject(new DOMException("The operation was aborted.", "AbortError"));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // A's finally must NOT remove B's entry. Pending should be:
    // u2, evictor, urlX(B) — u1 was evicted when B was inserted.
    expect(getPendingPrefetchCount()).toBe(3);

    // A third caller joins B instead of spawning a duplicate fetch
    prefetchNextTrackAudio(urlX);
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    clearNextTrackPrefetches();
    fetchSpy.mockRestore();
  });

  it("does not refetch an in-flight url", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    const url = "https://x/dup";
    prefetchNextTrackAudio(url);
    prefetchNextTrackAudio(url);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("reports the number of in-flight prefetches", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    expect(getPendingPrefetchCount()).toBe(0);
    prefetchNextTrackAudio("https://x/one");
    prefetchNextTrackAudio("https://x/two");
    expect(getPendingPrefetchCount()).toBe(2);
    clearNextTrackPrefetches();
    expect(getPendingPrefetchCount()).toBe(0);

    fetchSpy.mockRestore();
  });

  it("does not log an aborted prefetch (eviction/clear abort)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("aborted", "AbortError"),
            );
          });
        }),
    );

    prefetchNextTrackAudio("https://x/aborted");
    clearNextTrackPrefetches();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(captureError).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("classifies and logs fetch failures without full url", async () => {
    const err = new TypeError("Failed to fetch");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(err);

    prefetchNextTrackAudio("https://x/secret-token-1234567890");
    await new Promise((r) => setTimeout(r, 0));

    expect(captureError).toHaveBeenCalled();
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    const callArg = firstCall[0];
    expect(callArg.level).toBe("warn");
    expect(callArg.source).toBe("nextTrackPrefetcher");
    expect(callArg.message).not.toContain("secret-token-1234567890");
    expect(callArg.message).toContain("network");

    fetchSpy.mockRestore();
  });
});

describe("nextTrackPrefetcher body release (#7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNextTrackPrefetches();
  });

  it("#7 cancels the prefetch response body exactly once", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, body } as unknown as Response);

    prefetchNextTrackAudio("https://x/warm");
    await new Promise((r) => setTimeout(r, 0));

    expect(cancel).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it("#7 cancels the body when response is not ok", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      body,
    } as unknown as Response);

    prefetchNextTrackAudio("https://x/missing");
    await new Promise((r) => setTimeout(r, 0));

    expect(cancel).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it("#7 logs a short warning without url when response is not ok", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      body,
    } as unknown as Response);

    prefetchNextTrackAudio("https://x/notok-secret-98765");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(captureError).toHaveBeenCalled();
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    const callArg = firstCall[0];
    expect(callArg.level).toBe("warn");
    expect(callArg.source).toBe("nextTrackPrefetcher");
    expect(callArg.message).not.toContain("notok-secret-98765");

    fetchSpy.mockRestore();
  });

  it("#7 does not crash when response body is null", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, body: null } as unknown as Response);

    prefetchNextTrackAudio("https://x/empty-body");
    await new Promise((r) => setTimeout(r, 0));

    expect(captureError).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("#7 logs with truncated url and does not crash when cancel fails", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, body } as unknown as Response);

    prefetchNextTrackAudio("https://x/cancel-fail");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalled();
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    const callArg = firstCall[0];
    expect(callArg.level).toBe("warn");
    expect(callArg.source).toBe("nextTrackPrefetcher");
    expect(callArg.message).toContain("Prefetch body cancel failed");
    expect(callArg.message).not.toContain("cancel-fail");

    fetchSpy.mockRestore();
  });
});

describe("nextTrackPrefetcher AbortSignal composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNextTrackPrefetches();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("classifies a real timeout (TimeoutError DOMException) as (timeout)", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(20),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("aborted", "AbortError"),
            );
          });
        }),
    );

    prefetchNextTrackAudio("https://x/timing-out");
    await waitUntil(() => vi.mocked(captureError).mock.calls.length > 0);

    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    const callArg = firstCall[0];
    expect(callArg.message).toContain("(timeout)");
    expect(callArg.message).not.toContain("(aborted)");
  });

  it("evicts only the oldest in-flight controller and leaves no manual timers behind", () => {
    vi.useFakeTimers();
    const aborted: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((url, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted.push(
            typeof url === "string"
              ? url
              : url instanceof URL
                ? url.href
                : url.url,
          );
        });
        return Promise.resolve(new Response("", { status: 200 }));
      });

    const urls = ["a", "b", "c", "d"].map((u) => `https://x/${u}`);
    urls.forEach((u) => {
      prefetchNextTrackAudio(u);
    });

    expect(aborted).toEqual([urls[0]]);
    expect(vi.getTimerCount()).toBe(0);

    const first = urls[0];
    if (first === undefined) throw new Error("expected url");
    prefetchNextTrackAudio(first);
    expect(aborted).toEqual([urls[0], urls[1]]);
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    fetchSpy.mockRestore();
  });

  it("clearNextTrackPrefetches aborts every controller and empties the maps", () => {
    vi.useFakeTimers();
    const aborted: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((url, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted.push(
            typeof url === "string"
              ? url
              : url instanceof URL
                ? url.href
                : url.url,
          );
        });
        return Promise.resolve(new Response("", { status: 200 }));
      });

    const urls = ["a", "b"].map((u) => `https://x/${u}`);
    urls.forEach((u) => {
      prefetchNextTrackAudio(u);
    });
    expect(aborted).toEqual([]);

    clearNextTrackPrefetches();
    expect(aborted.sort()).toEqual([...urls].sort());
    expect(vi.getTimerCount()).toBe(0);

    const first = urls[0];
    if (first === undefined) throw new Error("expected url");
    prefetchNextTrackAudio(first);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    fetchSpy.mockRestore();
  });
});
