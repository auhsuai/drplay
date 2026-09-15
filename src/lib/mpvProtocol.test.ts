import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { captureError } from "../utils/errorLog";
import {
  BufferingTracker,
  BUFFERING_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_STALE_MS,
  classifyEndFileError,
  dispatchMpvEvent,
  dispatchPropertyEvent,
  resetWarnThrottleForTest,
  TimePosWatchdog,
  type MpvEventCallbacks,
} from "./mpvProtocol";

function makeCb(): MpvEventCallbacks {
  return {
    onTimeUpdate: vi.fn(),
    onDuration: vi.fn(),
    onPauseChange: vi.fn(),
    onBuffering: vi.fn(),
    onCacheState: vi.fn(),
    onFileLoaded: vi.fn(),
    onEndFile: vi.fn(),
    onEngineClosed: vi.fn(),
    onMalformed: vi.fn(),
  };
}

describe("TimePosWatchdog (mpv issue #13695 backfill)", () => {
  let isPlaying: boolean;
  let getTimePos: Mock<() => Promise<unknown>>;
  let onTimeUpdate: Mock<(time: number) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
    isPlaying = true;
    getTimePos = vi.fn(() => Promise.resolve(42));
    onTimeUpdate = vi.fn<(time: number) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeWatchdog(): TimePosWatchdog {
    return new TimePosWatchdog(
      () => isPlaying,
      () => getTimePos(),
      (time) => {
        onTimeUpdate(time);
      },
    );
  }

  it("stale >1200ms while playing polls mpv_get_property and forwards via onTimeUpdate", async () => {
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    // 1000ms since start <= stale threshold: healthy, no poll yet.
    expect(getTimePos).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);
    expect(onTimeUpdate).toHaveBeenCalledTimes(1);
    expect(onTimeUpdate).toHaveBeenCalledWith(42);

    // Recovery refreshed the staleness clock: no double-poll next tick.
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);
  });

  it("regular timeupdate pushes keep it quiet (no poll)", async () => {
    const wd = makeWatchdog();
    wd.start();

    for (let i = 0; i < 10; i++) {
      wd.noteEmit();
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(getTimePos).not.toHaveBeenCalled();
    expect(onTimeUpdate).not.toHaveBeenCalled();
  });

  it("isPlaying=false never arms an interval (no poll, no timer)", async () => {
    isPlaying = false;
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(5000);

    expect(getTimePos).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isPlaying flipping false mid-run stops itself (self-heal, no leak)", async () => {
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    isPlaying = false; // pause event flipped the store mid-watch
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getTimePos).not.toHaveBeenCalled();
  });

  it("stop() cancels the interval (release path, no timer leak)", async () => {
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);

    wd.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getTimePos).toHaveBeenCalledTimes(1);
  });

  it("null poll result skips the round (no forward) and rate-limits the nil-drop warn", async () => {
    getTimePos.mockReturnValue(Promise.resolve(null));
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "mpvProtocol",
      }),
    );
    const message = vi.mocked(captureError).mock.calls[0]?.[0]?.message ?? "";
    expect(message).toContain("time-pos");
    expect(message).toContain("null");

    // Next rounds keep polling (stale never refreshed) but stay silent <30s.
    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(4);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);

    // Past the 30s window the next nil round logs again.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(2);
  });

  it("poll rejection is a skipped round: warn with context, no throw, no forward", async () => {
    getTimePos.mockImplementation(() =>
      Promise.reject(new Error("mpv is not running (call mpv_spawn first)")),
    );
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "mpvProtocol" }),
    );

    wd.stop();
  });

  it("a hung poll does not stack overlapping invocations (in-flight guard)", async () => {
    getTimePos.mockReturnValue(new Promise(() => {}));
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);

    wd.stop();
  });

  it("stop() during an in-flight poll drops the late result (generation guard, no forward)", async () => {
    let resolvePoll!: (value: unknown) => void;
    getTimePos.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
    );
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1); // poll awaiting the IPC reply

    wd.stop(); // teardown while the poll is in flight
    resolvePoll(42);
    await vi.advanceTimersByTimeAsync(0);

    expect(onTimeUpdate).not.toHaveBeenCalled();
  });

  it("start() while already running does not stack a second interval", async () => {
    const wd = makeWatchdog();
    wd.start();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);

    wd.stop();
  });
});

describe("time-pos nil-drop warn (push path, rate-limited 1/30s)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    resetWarnThrottleForTest();
    vi.mocked(captureError).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a null time-pos push logs a warn with the raw value; repeat within 30s is silent", () => {
    const cb = makeCb();
    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(cb.onTimeUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "mpvProtocol" }),
    );
    const message = vi.mocked(captureError).mock.calls[0]?.[0]?.message ?? "";
    expect(message).toContain("time-pos");

    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
  });

  it("past 30s the next nil push logs again", () => {
    const cb = makeCb();
    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(2);
  });

  it("finite time-pos and other properties never log", () => {
    const cb = makeCb();
    dispatchPropertyEvent({ name: "time-pos", data: 42 }, cb);
    dispatchPropertyEvent({ name: "duration", data: null }, cb);
    dispatchPropertyEvent({ name: "pause", data: null }, cb);
    expect(cb.onTimeUpdate).toHaveBeenCalledWith(42);
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
  });

  it("the watchdog and the push path share one rate-limit window", async () => {
    const cb = makeCb();
    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);

    // Watchdog nil round within the same window: still silent.
    const wd = new TimePosWatchdog(
      () => true,
      () => Promise.resolve(null),
      () => {},
    );
    wd.start();
    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(vi.mocked(captureError).mock.calls.length).toBeGreaterThanOrEqual(2);
    wd.stop();
  });
});

describe("BufferingTracker v3 settle rules (spinner contract guard)", () => {
  it("request(true) promotes at once; two CHANGED ticks within 1s settle; the watchdog reuses onTimeTick without altering the rule", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true); // playTrack path: immediate promote (S2)
      expect(emitted).toEqual([true]);

      tracker.onTimeTick(1);
      tracker.onTimeTick(1); // same value — not progress (S4)
      vi.advanceTimersByTime(100);
      tracker.onTimeTick(2); // 2nd CHANGED value within 1s
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("request() default keeps the 250ms display delay (seek anti-flash) and settles on two changed ticks", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(); // seek path
      vi.advanceTimersByTime(249);
      expect(emitted).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(emitted).toEqual([true]);

      tracker.onTimeTick(10);
      tracker.onTimeTick(10.5);
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BufferingTracker v4 (mpv paused-for-cache spin-hold)", () => {
  it("a changed tick pair never settles while mpv reports paused-for-cache=true; report(false) is the settle signal", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      expect(emitted).toEqual([true]);

      tracker.reportMpvBuffering(true);
      tracker.onTimeTick(1);
      tracker.onTimeTick(2); // changed within 1s — v3 settled here
      expect(emitted, "tick pair settled during a real stall").toEqual([true]);
      expect(tracker.isShown()).toBe(true);

      tracker.reportMpvBuffering(false); // mpv: stall over
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the safety net re-arms while paused-for-cache=true instead of settling a shown spinner", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      tracker.reportMpvBuffering(true);

      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS);
      expect(emitted, "safety net settled during the stall").toEqual([true]);
      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS); // re-armed net fires too
      expect(emitted).toEqual([true]);
      expect(tracker.isShown()).toBe(true);

      tracker.reportMpvBuffering(false);
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the safety net still settles a shown spinner when mpv is NOT buffering (no regression)", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS);
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("report(false) re-opens tick-settle for the next request", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      tracker.reportMpvBuffering(true);
      tracker.onTimeTick(1);
      tracker.onTimeTick(2); // blocked
      tracker.reportMpvBuffering(false); // shown -> settle
      expect(emitted).toEqual([true, false]);

      tracker.request(true);
      tracker.onTimeTick(3);
      tracker.onTimeTick(3.5);
      expect(emitted).toEqual([true, false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() drops the stall flag: a dead mpv report never blocks the next engine's ticks", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      tracker.reportMpvBuffering(true);

      tracker.cancel(); // release path: silent
      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS + 1);
      expect(emitted).toEqual([true]);
      expect(tracker.isShown()).toBe(false);

      tracker.request(true);
      tracker.onTimeTick(1);
      tracker.onTimeTick(2);
      expect(emitted).toEqual([true, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchdog constants", () => {
  it("keeps the locked v3 tuning", () => {
    expect(WATCHDOG_INTERVAL_MS).toBe(1000);
    expect(WATCHDOG_STALE_MS).toBe(1200);
  });
});

describe("dispatchMpvEvent routing (R02-1 / R02-2)", () => {
  it("end-file error carries mpv's error string to onEndFile", () => {
    const cb = makeCb();
    // Realistic mpv string: mpv_error_string() output, not ffmpeg detail.
    dispatchMpvEvent(
      { event: "end-file", reason: "error", error: "loading failed" },
      cb,
    );
    expect(cb.onEndFile).toHaveBeenCalledWith("error", "loading failed");
  });

  it("end-file error without an error field passes null", () => {
    const cb = makeCb();
    dispatchMpvEvent({ event: "end-file", reason: "error" }, cb);
    expect(cb.onEndFile).toHaveBeenCalledWith("error", null);
  });

  it("end-file eof stays a single-argument outcome", () => {
    const cb = makeCb();
    dispatchMpvEvent({ event: "end-file", reason: "eof" }, cb);
    expect(cb.onEndFile).toHaveBeenCalledWith("eof");
  });

  it("ipc-closed routes the engine-closed cause to onEngineClosed", () => {
    const cb = makeCb();
    dispatchMpvEvent({ event: "ipc-closed", reason: "eof", error: null }, cb);
    expect(cb.onEngineClosed).toHaveBeenCalledWith("eof");
    expect(cb.onEndFile).not.toHaveBeenCalled();
  });

  it("ipc-closed without a reason still notifies with a cause string", () => {
    const cb = makeCb();
    dispatchMpvEvent({ event: "ipc-closed" }, cb);
    expect(cb.onEngineClosed).toHaveBeenCalledWith(expect.any(String));
  });
});

describe("classifyEndFileError (R05: proxy status is the primary source)", () => {
  it("proxy 5xx is a retryable network failure — mpv's string cannot overrule it", () => {
    expect(classifyEndFileError("loading failed", 503)).toBe("network");
    expect(classifyEndFileError("unrecognized file format", 502)).toBe(
      "network",
    );
    expect(classifyEndFileError(null, 504)).toBe("network");
  });

  it("proxy 408/429/499 (timeout / rate limit / idle-abort) are retryable network", () => {
    expect(classifyEndFileError("loading failed", 408)).toBe("network");
    expect(classifyEndFileError("something happened", 429)).toBe("network");
    expect(classifyEndFileError(null, 499)).toBe("network");
  });

  it("proxy 4xx (locked/quota/forbidden/not found) stays format (storm guard)", () => {
    expect(classifyEndFileError("loading failed", 403)).toBe("format");
    expect(classifyEndFileError("unrecognized file format", 404)).toBe(
      "format",
    );
    expect(classifyEndFileError(null, 410)).toBe("format");
    expect(classifyEndFileError("something happened", 400)).toBe("format");
  });

  it("no proxy data: mpv's real short strings keep the format default (100% parity)", () => {
    expect(classifyEndFileError(null)).toBe("format");
    expect(classifyEndFileError(undefined)).toBe("format");
    expect(classifyEndFileError("")).toBe("format");
    expect(classifyEndFileError("   ")).toBe("format");
    expect(classifyEndFileError("loading failed")).toBe("format");
    expect(classifyEndFileError("unrecognized file format")).toBe("format");
    expect(classifyEndFileError("something happened", null)).toBe("format");
    expect(classifyEndFileError("Could not open codec.", undefined)).toBe(
      "format",
    );
  });

  it("no proxy data: the transport regex stays as a weak fallback only", () => {
    expect(classifyEndFileError("Connection reset by peer")).toBe("network");
    expect(classifyEndFileError("connection timed out")).toBe("network");
    expect(classifyEndFileError("http error 403")).toBe("format");
  });
});
