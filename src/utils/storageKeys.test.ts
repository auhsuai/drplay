// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_TIME_KEY,
  SORT_OPTION_KEY,
  ROOT_FOLDER_KEY,
  safeLocalStorageGet,
  safeLocalStorageSet,
} from "./storageKeys";
import { captureError } from "./errorLog";

vi.mock("./errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedCaptureError = vi.mocked(captureError);

afterEach(() => {
  vi.restoreAllMocks();
});

// Guard test: these key values are shared across useAuth, apiClient,
// useServiceWorker and useAppGlobalEvents. Renaming any of them in one place
// without the others would silently split the token session, so the exact
// string values are pinned here to fail loudly on accidental drift.
describe("storageKeys token keys", () => {
  it("pins the exact localStorage key values used by the auth modules", () => {
    expect(ACCESS_TOKEN_KEY).toBe("drplay_access_token");
    expect(REFRESH_TOKEN_KEY).toBe("drplay_refresh_token");
    expect(TOKEN_TIME_KEY).toBe("drplay_token_time");
  });
});

describe("safeLocalStorageGet", () => {
  it("returns the stored value on success", () => {
    localStorage.setItem(SORT_OPTION_KEY, "artist");
    expect(safeLocalStorageGet(SORT_OPTION_KEY, "sort-option-read")).toBe(
      "artist",
    );
  });

  it("returns null and logs a warn `label-failed:<name>` when getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    const result = safeLocalStorageGet(SORT_OPTION_KEY, "sort-option-read");
    expect(result).toBeNull();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "useDrive",
      message: "sort-option-read-failed:SecurityError",
    });
  });
});

describe("safeLocalStorageSet", () => {
  it("writes the value on success", () => {
    safeLocalStorageSet(ROOT_FOLDER_KEY, "root-B", "root-folder-write");
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-B");
  });

  it("does not throw and logs a warn `label-failed:<name>` when setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => {
      safeLocalStorageSet(ROOT_FOLDER_KEY, "x", "root-folder-write");
    }).not.toThrow();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "useDrive",
      message: "root-folder-write-failed:QuotaExceededError",
    });
  });
});
