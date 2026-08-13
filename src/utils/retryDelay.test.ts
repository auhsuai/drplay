import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, mergeWithTimeoutSignal, sleep } from "./retryDelay";

afterEach(() => {
  vi.useRealTimers();
});

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("backoffDelay", () => {
  it("honors numeric Retry-After in seconds (capped at 32s)", () => {
    expect(backoffDelay(0, "5")).toBe(5000);
    expect(backoffDelay(0, "100")).toBe(32000); // 100s > cap
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
    expect(d).toBeGreaterThanOrEqual(1000);
    expect(d).toBeLessThanOrEqual(1500); // attempt 0 jitter bound
  });

  it("ignores an unparseable Retry-After and falls back to exp backoff", () => {
    const d = backoffDelay(0, "abc");
    expect(d).toBeGreaterThanOrEqual(1000);
    expect(d).toBeLessThanOrEqual(1500);
  });

  it("uses exponential backoff + jitter bounded at base for attempt 0", () => {
    const d = backoffDelay(0);
    expect(d).toBeGreaterThanOrEqual(1000);
    expect(d).toBeLessThanOrEqual(1500); // 1000 + up to 50% jitter
  });

  it("doubles the exponential base per attempt", () => {
    const d = backoffDelay(1);
    expect(d).toBeGreaterThanOrEqual(2000);
    expect(d).toBeLessThanOrEqual(3000); // 2000 + up to 50% jitter
  });

  it("caps exponential backoff at 32s", () => {
    expect(backoffDelay(5)).toBe(32000);
    expect(backoffDelay(10)).toBe(32000);
  });

  it("prefers Retry-After over the exponential base even at attempt 0", () => {
    expect(backoffDelay(0, "0")).toBe(0); // 0s is finite and valid
  });
});

describe("sleep", () => {
  it("resolves after the given milliseconds (fake timer)", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = sleep(500).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(resolved).toBe(true);
  });
});

describe("mergeWithTimeoutSignal", () => {
  it("merges the caller signal with the timeout via AbortSignal.any", () => {
    const controller = new AbortController();
    const merged = mergeWithTimeoutSignal(controller.signal, 60_000);
    expect(merged.aborted).toBe(false);
    controller.abort();
    expect(merged.aborted).toBe(true);
  });

  it("returns a timeout-only signal when no caller signal is given", () => {
    const merged = mergeWithTimeoutSignal(null, 60_000);
    expect(merged.aborted).toBe(false);
  });

  it("aborts once the timeout elapses", async () => {
    const merged = mergeWithTimeoutSignal(null, 50);
    expect(merged.aborted).toBe(false);
    await realDelay(200);
    expect(merged.aborted).toBe(true);
  });

  it("falls back to a timeout-only signal when AbortSignal.any is unavailable", () => {
    const anySlot = AbortSignal as unknown as {
      any: (typeof AbortSignal)["any"] | undefined;
    };
    const originalAny: (typeof AbortSignal)["any"] =
      AbortSignal.any.bind(AbortSignal);
    anySlot.any = undefined;
    try {
      const controller = new AbortController();
      const merged = mergeWithTimeoutSignal(controller.signal, 60_000);
      controller.abort();
      expect(merged.aborted).toBe(false); // caller signal NOT merged in
    } finally {
      anySlot.any = originalAny;
    }
  });
});
