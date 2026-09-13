import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { captureError } from "../utils/errorLog";
import {
  BufferingTracker,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_STALE_MS,
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

describe("watchdog constants", () => {
  it("keeps the locked v3 tuning", () => {
    expect(WATCHDOG_INTERVAL_MS).toBe(1000);
    expect(WATCHDOG_STALE_MS).toBe(1200);
  });
});
