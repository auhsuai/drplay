// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMetadataFetchEnabled, setMetadataFetchEnabled } from "./settings";
import { captureError } from "../errorLog";

vi.mock("../errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedCaptureError = vi.mocked(captureError);

const KEY = "drplay_metadata_fetch_enabled";

// Mirrors the loadMinimizeToTrayState contract (appUiState.ts): the read goes
// through the storageKeys SSOT helper so a blocked storage is LOGGED while the
// value contract (missing/blocked -> true, strict 'true' -> true, else false)
// stays 100%.
describe("isMetadataFetchEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("defaults to true when the key is missing (first launch)", () => {
    expect(isMetadataFetchEnabled()).toBe(true);
  });

  it("returns true when the stored value is exactly 'true'", () => {
    localStorage.setItem(KEY, "true");
    expect(isMetadataFetchEnabled()).toBe(true);
  });

  it("returns false when the stored value is 'false'", () => {
    localStorage.setItem(KEY, "false");
    expect(isMetadataFetchEnabled()).toBe(false);
  });

  it("returns false for any corrupt value (e.g. 'yes')", () => {
    localStorage.setItem(KEY, "yes");
    expect(isMetadataFetchEnabled()).toBe(false);
  });

  it("falls back to true and logs a warn when localStorage.getItem throws (SecurityError)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(isMetadataFetchEnabled()).toBe(true);
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "metadataSettings",
      message: "metadata-fetch-read-failed:SecurityError",
    });
  });
});

describe("setMetadataFetchEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("writes the stringified value under the metadata fetch key", () => {
    setMetadataFetchEnabled(false);
    expect(localStorage.getItem(KEY)).toBe("false");

    setMetadataFetchEnabled(true);
    expect(localStorage.getItem(KEY)).toBe("true");
  });
});
