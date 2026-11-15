// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DOWNLOAD_FAB_STORAGE_KEY,
  clampFabPosition,
  loadFabPosition,
  saveFabPosition,
} from "./downloadFabPosition";

describe("clampFabPosition", () => {
  it("keeps the button 16px inside every edge of the content area", () => {
    // 800×600 area, 56px button: x in [16, 728], y in [16, 528].
    expect(clampFabPosition(0, 0, 800, 600)).toEqual({ x: 16, y: 16 });
    expect(clampFabPosition(900, 700, 800, 600)).toEqual({
      x: 728,
      y: 528,
    });
    expect(clampFabPosition(100, 100, 800, 600)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("never inverts the range on a tiny container", () => {
    expect(clampFabPosition(0, 0, 40, 40)).toEqual({ x: 16, y: 16 });
  });
});

describe("download FAB position persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("round-trips through localStorage", () => {
    saveFabPosition({ x: 120, y: 300 });
    expect(loadFabPosition()).toEqual({ x: 120, y: 300 });
  });

  it("returns null when nothing was saved, or the JSON is invalid", () => {
    expect(loadFabPosition()).toBeNull();
    localStorage.setItem(DOWNLOAD_FAB_STORAGE_KEY, "not json{");
    expect(loadFabPosition()).toBeNull();
    localStorage.setItem(DOWNLOAD_FAB_STORAGE_KEY, '{"x":"a","y":1}');
    expect(loadFabPosition()).toBeNull();
  });
});
