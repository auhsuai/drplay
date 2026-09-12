import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INTERPOLATOR_TICK_MS, TimeInterpolator } from "./timeInterpolator";

describe("TimeInterpolator (engine clock, push-gap backfill)", () => {
  let isPlaying: boolean;
  let emitted: number[];
  let interp: TimeInterpolator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // move Date.now() off the 0 sentinel
    isPlaying = true;
    emitted = [];
    interp = new TimeInterpolator(
      () => isPlaying,
      (time) => {
        emitted.push(time);
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("no real push yet (fresh track): ticks stay silent", async () => {
    interp.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(emitted).toEqual([]);
  });

  it("push silence while playing: emits interpolated time, strictly increasing", async () => {
    interp.noteRealTime(0.2); // the only real push — mpv then goes quiet
    interp.start();

    await vi.advanceTimersByTimeAsync(3000);

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0] ?? Number.NaN).toBeGreaterThan(0.2);
    let prev = 0.2;
    for (const t of emitted) {
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it("dense real pushes (<250ms apart): zero synthetic emits", async () => {
    interp.start();
    for (let i = 1; i <= 10; i++) {
      interp.noteRealTime(i * 0.2);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(emitted).toEqual([]);
  });

  it("a fresh real push suppresses the tick that lands inside the push window", async () => {
    interp.noteRealTime(5);
    interp.start();
    await vi.advanceTimersByTimeAsync(INTERPOLATOR_TICK_MS - 100);
    interp.noteRealTime(5.15); // fresh push 150ms before the next tick
    await vi.advanceTimersByTimeAsync(100); // tick: only 100ms since the push
    expect(emitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(INTERPOLATOR_TICK_MS); // next tick: 350ms since
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("isPlaying=false: silent, and the tick timer self-stops", async () => {
    interp.noteRealTime(1);
    interp.start();
    isPlaying = false;

    await vi.advanceTimersByTimeAsync(2000);

    expect(emitted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reset(): stops ticking and drops the base — old time never leaks after re-arm", async () => {
    interp.noteRealTime(50);
    interp.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(emitted.length).toBeGreaterThan(0);

    interp.reset();
    emitted = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(emitted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    interp.start(); // resumed playing without a new real push yet
    await vi.advanceTimersByTimeAsync(2000);
    expect(emitted).toEqual([]);
  });

  it("buffering shown: no synthetic emits while stalled (clock frozen)", async () => {
    let buffering = false;
    emitted = [];
    interp = new TimeInterpolator(
      () => isPlaying,
      (time) => {
        emitted.push(time);
      },
      () => buffering,
    );
    interp.noteRealTime(111);
    interp.start();

    buffering = true; // mpv paused-for-cache promoted to shown
    await vi.advanceTimersByTimeAsync(2000);

    expect(emitted).toEqual([]);
  });

  it("buffering settle: resumes from truth without paying out stalled wall-time", async () => {
    let buffering = false;
    emitted = [];
    interp = new TimeInterpolator(
      () => isPlaying,
      (time) => {
        emitted.push(time);
      },
      () => buffering,
    );
    interp.noteRealTime(111);
    interp.start();

    buffering = true;
    await vi.advanceTimersByTimeAsync(5000); // long stall — stays silent
    expect(emitted).toEqual([]);

    buffering = false; // spinner settles, no real push yet
    await vi.advanceTimersByTimeAsync(INTERPOLATOR_TICK_MS * 2);
    // At most ~0.5s of drift from the frozen base — never the 5s stall jump.
    for (const t of emitted) {
      expect(t - 111).toBeLessThan(1);
    }

    // Real push after settle re-bases the truth and the clock follows it.
    emitted = [];
    interp.noteRealTime(112);
    await vi.advanceTimersByTimeAsync(INTERPOLATOR_TICK_MS * 2);
    expect(emitted.length).toBeGreaterThan(0);
    for (const t of emitted) {
      expect(t).toBeGreaterThanOrEqual(112);
      expect(t - 112).toBeLessThan(1);
    }
  });
});
