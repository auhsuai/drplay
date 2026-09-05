import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, mergeWithTimeoutSignal, sleep } from "./retryDelay";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("backoffDelay", () => {
  it("honors numeric Retry-After in seconds (capped at 32s)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(backoffDelay(0, "5")).toBe(5000); // floor: 5000 + zero jitter
    } finally {
      vi.restoreAllMocks();
    }
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

  it("applies opts.maxMs as the cap on Retry-After and exponential paths", () => {
    expect(backoffDelay(0, "100", { maxMs: 8000 })).toBe(8000); // 100s > 8s cap
    expect(backoffDelay(5, undefined, { maxMs: 8000 })).toBe(8000); // exp capped
  });

  it("uses opts.jitterMaxMs as a fixed integer jitter window, also on Retry-After", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      expect(backoffDelay(0, undefined, { jitterMaxMs: 500 })).toBe(1500); // 1000 + floor(0.999*501)
      expect(backoffDelay(0, "3", { jitterMaxMs: 500 })).toBe(3500); // 3000 + 500
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("jitters a numeric Retry-After on the default path (thundering-herd guard)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      // 5000 + 0.5 * 5000 * 0.5 = 6250
      expect(backoffDelay(0, "5")).toBe(6250);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("jitters an HTTP-date Retry-After on the default path, still capped", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const future = new Date(1_000_000 + 10_000).toUTCString();
      // diff 10000 + 0.5 * 10000 * 0.5 = 12500
      expect(backoffDelay(0, future)).toBe(12500);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("caps default-path Retry-After + jitter at maxMs even with random maxed", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      expect(backoffDelay(0, "100")).toBe(32000);
      expect(backoffDelay(0, "31", { maxMs: 8000 })).toBe(8000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("caps worker-mode Retry-After + jitter at maxMs (no cap overflow)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      // 8000 + floor(0.999*501) = 8500 without the re-cap
      expect(
        backoffDelay(0, "8", { maxMs: 8000, jitterMaxMs: 500 }),
      ).toBeLessThanOrEqual(8000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("caps worker-mode exponential + jitter at maxMs", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      expect(
        backoffDelay(5, undefined, { maxMs: 8000, jitterMaxMs: 500 }),
      ).toBeLessThanOrEqual(8000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("clamps a negative attempt to the attempt-0 floor", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(backoffDelay(-1)).toBe(1000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps Retry-After: 0 at exactly 0 (server says retry immediately)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      expect(backoffDelay(0, "0")).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
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

  it("rejects with signal.reason when the signal is already aborted", async () => {
    vi.useFakeTimers();
    const stop = new Error("stop");
    const controller = new AbortController();
    controller.abort(stop);
    const assertion = expect(sleep(5000, controller.signal)).rejects.toBe(stop);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("rejects with signal.reason when aborted mid-sleep", async () => {
    vi.useFakeTimers();
    const stop = new Error("stop");
    const controller = new AbortController();
    const assertion = expect(sleep(30_000, controller.signal)).rejects.toBe(
      stop,
    );
    controller.abort(stop);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
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
