import { afterEach, describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

// Slice 4: the prefetch fetch must carry an AbortSignal.timeout deadline so a
// stalled Drive fetch cannot become a zombie holding a connection (and the
// SW) alive forever. An abort lands in the existing 'prefetch failed' catch
// (best-effort warm-cache loss only — playback has its own request path).
//
// Coverage note: AbortSignal.timeout uses a NATIVE timer that vitest fake
// timers cannot advance, so the 120s deadline firing itself is not unit-
// testable in this sandbox. These tests pin (a) the signal exists on the
// Request handed to fetch with the exact 120_000 deadline value, and
// (b) an AbortError rejection is contained by the existing catch (warn once,
// never throws, no retry on the aborted attempt).

type SwListener = (event: unknown) => void;

function makeSw() {
  const listeners = new Map<string, SwListener>();
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, handler: SwListener) => {
      listeners.set(type, handler);
    },
    skipWaiting: vi.fn(),
    clients: { matchAll: vi.fn(() => []), claim: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- deliberate: runs the raw sw.js text in a sandboxed scope with a fake `self`
  new Function("self", swSource)(fakeSelf);
  return {
    emit: (type: string, event: unknown) => listeners.get(type)?.(event),
  };
}

// Emits PREFETCH_TRACK and captures the promises registered via waitUntil so
// tests can await the (otherwise fire-and-forget) prefetch to completion.
function emitPrefetch(
  sw: ReturnType<typeof makeSw>,
  fileId: string,
): Promise<unknown>[] {
  const pending: Promise<unknown>[] = [];
  sw.emit("message", {
    data: { type: "PREFETCH_TRACK", fileId },
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  });
  return pending;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sw.js prefetch fetch deadline (Slice 4)", () => {
  it("bounds the prefetch attempt with an AbortSignal timeout of 120s (zombie-fetch guard)", async () => {
    const sw = makeSw();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    // Non-retryable 404: exactly one fetch attempt, no body read, no IDB.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 404,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    await Promise.all(emitPrefetch(sw, "f1"));

    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request).toBeInstanceOf(Request);
    // The Request carries a deadline signal. Identity (request.signal ===
    // the spy's result) is NOT asserted: Node/undici's Request constructor
    // rebinds init.signal, so object identity only holds in the real
    // Chromium runtime, not in this Node sandbox.
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal.aborted).toBe(false);
  });

  it("an aborted prefetch lands in the existing 'prefetch failed' catch — warns once, never throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sw = makeSw();
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation was aborted", "AbortError"),
      );
    vi.stubGlobal("fetch", fetchMock);

    sw.emit("message", { data: { type: "UPDATE_TOKEN", token: "tok" } });
    const pending = emitPrefetch(sw, "f1");

    // The prefetch promise resolves (never rejects out of waitUntil).
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("prefetch failed");
    // A rejected (aborted) attempt is not retried by fetchWithBackoff.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
