// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMinimizeToTrayState, saveMinimizeToTrayState } from "./appUiState";
import { captureError } from "./utils/errorLog";

vi.mock("./utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedCaptureError = vi.mocked(captureError);

// B20-1: the read must go through the storageKeys SSOT helper so a blocked
// storage is LOGGED (Luật 4 — no silent swallow) while the value contract
// (missing/blocked -> true, strict 'true' -> true, else false) stays 100%.
describe("loadMinimizeToTrayState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("defaults to true when the key is missing (first launch)", () => {
    expect(loadMinimizeToTrayState()).toBe(true);
  });

  it("returns true when the stored value is exactly 'true'", () => {
    localStorage.setItem("drplay_minimize_to_tray", "true");
    expect(loadMinimizeToTrayState()).toBe(true);
  });

  it("returns false for any other stored value ('false' / corrupt)", () => {
    localStorage.setItem("drplay_minimize_to_tray", "false");
    expect(loadMinimizeToTrayState()).toBe(false);
    localStorage.setItem("drplay_minimize_to_tray", "garbage");
    expect(loadMinimizeToTrayState()).toBe(false);
  });

  it("falls back to true and logs a warn when localStorage.getItem throws (SecurityError)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(loadMinimizeToTrayState()).toBe(true);
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "appUiState",
      message: "minimize-to-tray-read-failed:SecurityError",
    });
  });
});

describe("saveMinimizeToTrayState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("writes the stringified value under the tray key", () => {
    saveMinimizeToTrayState(false);
    expect(localStorage.getItem("drplay_minimize_to_tray")).toBe("false");

    saveMinimizeToTrayState(true);
    expect(localStorage.getItem("drplay_minimize_to_tray")).toBe("true");
  });

  it("does not throw and logs a warn when setItem throws (QuotaExceededError)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => {
      saveMinimizeToTrayState(true);
    }).not.toThrow();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "appUiState",
      message: "tray-write-failed:QuotaExceededError",
    });
  });
});
