import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { BufferingTracker, TimePosWatchdog } from "./mpvPlaybackMachines";
import { INTERPOLATOR_TICK_MS, TimeInterpolator } from "./timeInterpolator";
import { TimerRegistry } from "./timerRegistry";

describe("TimerRegistry (R1.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("arms exactly one native timer per entry and self-drops a fired timeout", async () => {
    const registry = new TimerRegistry();
    const fn = vi.fn();
    registry.setTimeout("demo", fn, 100);

    expect(registry.activeTimerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(registry.activeTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clearTimeout unregisters only the cleared handle", () => {
    const registry = new TimerRegistry();
    const a = registry.setTimeout("a", () => {}, 100);
    registry.setTimeout("b", () => {}, 100);
    expect(registry.activeTimerCount()).toBe(2);

    registry.clearTimeout(a);

    expect(registry.activeTimerNames()).toEqual(["b"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("setInterval registers under its name and clearInterval unregisters it", () => {
    const registry = new TimerRegistry();
    const fn = vi.fn();
    const handle = registry.setInterval("tick", fn, 50);

    expect(registry.activeTimerNames()).toEqual(["tick"]);
    expect(vi.getTimerCount()).toBe(1);

    registry.clearInterval(handle);
    expect(registry.activeTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("playback machines register their timers through the registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("watchdog interval: start registers, stop unregisters", () => {
    const registry = new TimerRegistry();
    const wd = new TimePosWatchdog(
      () => true,
      () => Promise.resolve(42),
      () => {},
      registry,
    );

    wd.start();
    expect(registry.activeTimerNames()).toEqual(["watchdog"]);

    wd.stop();
    expect(registry.activeTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("buffering tracker: display + deadline register, settle drains both", () => {
    const registry = new TimerRegistry();
    const tracker = new BufferingTracker(() => {}, registry);

    tracker.request();
    expect(registry.activeTimerNames().sort()).toEqual([
      "buffering-deadline",
      "buffering-display",
    ]);

    tracker.settle();
    expect(registry.activeTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interpolator interval: start registers, tick self-stop unregisters", async () => {
    const registry = new TimerRegistry();
    let isPlaying = true;
    const interp = new TimeInterpolator(
      () => isPlaying,
      () => {},
      () => false,
      registry,
    );

    interp.start();
    expect(registry.activeTimerNames()).toEqual(["interpolator"]);

    isPlaying = false;
    await vi.advanceTimersByTimeAsync(INTERPOLATOR_TICK_MS * 2);

    expect(registry.activeTimerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
