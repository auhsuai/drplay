// @vitest-environment node
//
// Pure arithmetic behind the PiP aspect lock. `applyPipAspect` is deliberately
// NOT covered here: it is an I/O best-effort sequence (Tauri window calls) and
// is asserted end-to-end in `PipWindowView.test.tsx` where those calls are
// mocked. These tests only pin the four functions that take numbers in and give
// numbers out — the part that silently corrupts a window rect when it drifts.
import { describe, expect, it } from "vitest";
import {
  clampToMonitor,
  minSizeForAspect,
  safeTime,
  safeVolume,
  type WindowSize,
} from "./pipWindowSizing";

const SIXTEEN_BY_NINE = 16 / 9;
const PORTRAIT = 9 / 16;

describe("safeTime", () => {
  it("clamps every unusable value to zero", () => {
    expect(safeTime(undefined)).toBe(0);
    expect(safeTime(Number.NaN)).toBe(0);
    expect(safeTime(Number.POSITIVE_INFINITY)).toBe(0);
    expect(safeTime(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(safeTime(0)).toBe(0);
    expect(safeTime(-3)).toBe(0);
  });

  it("passes a real position through untouched", () => {
    expect(safeTime(12.5)).toBe(12.5);
  });
});

describe("safeVolume", () => {
  it("falls back to full volume for missing or non-finite input", () => {
    expect(safeVolume(undefined)).toBe(1);
    expect(safeVolume(Number.NaN)).toBe(1);
    expect(safeVolume(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("clamps out-of-range levels into 0..1", () => {
    expect(safeVolume(-1)).toBe(0);
    expect(safeVolume(2)).toBe(1);
    expect(safeVolume(0.42)).toBe(0.42);
  });
});

describe("minSizeForAspect", () => {
  it("puts the 320px floor on the long side for a landscape ratio", () => {
    expect(minSizeForAspect(SIXTEEN_BY_NINE)).toEqual({
      width: 320,
      height: 180,
    });
  });

  it("puts the 320px floor on the long side for a portrait ratio", () => {
    expect(minSizeForAspect(PORTRAIT)).toEqual({ width: 180, height: 320 });
  });

  it("treats a square video as landscape", () => {
    expect(minSizeForAspect(1)).toEqual({ width: 320, height: 320 });
  });

  it("never returns a zero or negative side", () => {
    for (const aspect of [0.01, 0.5, 1, 2, 100]) {
      const size = minSizeForAspect(aspect);
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("clampToMonitor", () => {
  const SMALL_MONITOR: WindowSize = { width: 1280, height: 720 };

  it("returns the target unchanged when the monitor is unknown", () => {
    const target: WindowSize = { width: 480, height: 853 };
    expect(clampToMonitor(target, PORTRAIT, null)).toBe(target);
  });

  it("leaves a target that already fits alone", () => {
    expect(
      clampToMonitor(
        { width: 480, height: 270 },
        SIXTEEN_BY_NINE,
        SMALL_MONITOR,
      ),
    ).toEqual({ width: 480, height: 270 });
  });

  it("caps a portrait video at 90% of the monitor height and keeps the ratio", () => {
    const clamped = clampToMonitor(
      { width: 480, height: 853 },
      PORTRAIT,
      SMALL_MONITOR,
    );

    expect(clamped.height).toBe(648);
    expect(clamped.height).toBeLessThanOrEqual(720 * 0.9);
    expect(
      Math.abs(clamped.width - clamped.height * PORTRAIT),
    ).toBeLessThanOrEqual(1);
  });

  it("caps an over-wide target by width and recomputes the height", () => {
    const clamped = clampToMonitor(
      { width: 4_000, height: 2_250 },
      SIXTEEN_BY_NINE,
      SMALL_MONITOR,
    );

    expect(clamped.width).toBe(1_152);
    expect(clamped.height).toBeLessThanOrEqual(648);
    expect(
      Math.abs(clamped.height - clamped.width / SIXTEEN_BY_NINE),
    ).toBeLessThanOrEqual(1);
  });

  it("never returns a side smaller than one pixel", () => {
    const clamped = clampToMonitor({ width: 10_000, height: 10_000 }, 1_000, {
      width: 1,
      height: 1,
    });

    expect(clamped.width).toBeGreaterThanOrEqual(1);
    expect(clamped.height).toBeGreaterThanOrEqual(1);
  });
});
