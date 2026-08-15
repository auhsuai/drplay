// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureError } from "./errorLog";
import { appDataDir, downloadDir } from "@tauri-apps/api/path";
import {
  getCustomDownloadPath,
  getEffectiveDownloadPath,
  setCustomDownloadPath,
  getMobileDownloadFolder,
  setMobileDownloadFolder,
  clearMobileDownloadFolder,
} from "./downloadPath";

vi.mock("./errorLog", () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

// IS_MOBILE is read at call time inside downloadPath.ts functions, so a
// getter-backed mock lets the same module flip between desktop/mobile.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("./platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn(),
  appDataDir: vi.fn(),
}));

const mockedCaptureError = vi.mocked(captureError);
const mockedDownloadDir = vi.mocked(downloadDir);
const mockedAppDataDir = vi.mocked(appDataDir);

describe("downloadPath", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = false;
    vi.clearAllMocks();
    localStorage.clear();
    mockedDownloadDir.mockResolvedValue("/home/user/Music");
    mockedAppDataDir.mockResolvedValue("/data/user/0/com.drplay/files");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getCustomDownloadPath: SecurityError from localStorage.getItem is caught → returns null and logs", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(getCustomDownloadPath()).toBeNull();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "downloadPath",
      message: "custom-path-read-failed:SecurityError",
    });
  });

  it("setCustomDownloadPath: QuotaExceededError from setItem does not throw and logs", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => {
      setCustomDownloadPath("C:\\Music");
    }).not.toThrow();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "downloadPath",
      message: "custom-path-write-failed:QuotaExceededError",
    });
  });

  it("getCustomDownloadPath: returns the stored value verbatim when available", () => {
    localStorage.setItem("drplay_download_path", "D:\\Songs");
    expect(getCustomDownloadPath()).toBe("D:\\Songs");
  });

  it("getEffectiveDownloadPath: falls back to downloadDir() when no custom path is set", async () => {
    await expect(getEffectiveDownloadPath()).resolves.toBe("/home/user/Music");
    expect(mockedDownloadDir).toHaveBeenCalledTimes(1);
  });

  it("getEffectiveDownloadPath: returns the custom path without touching downloadDir()", async () => {
    localStorage.setItem("drplay_download_path", "E:\\Flac");
    await expect(getEffectiveDownloadPath()).resolves.toBe("E:\\Flac");
    expect(mockedDownloadDir).not.toHaveBeenCalled();
  });
});

describe("downloadPath mobile (IS_MOBILE)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("getEffectiveDownloadPath: returns appDataDir() on mobile, ignoring downloadDir() and any custom path", async () => {
    platformMock.IS_MOBILE = true;
    localStorage.setItem("drplay_download_path", "E:\\Flac");
    await expect(getEffectiveDownloadPath()).resolves.toBe(
      "/data/user/0/com.drplay/files",
    );
    expect(mockedAppDataDir).toHaveBeenCalledTimes(1);
    expect(mockedDownloadDir).not.toHaveBeenCalled();
  });

  it("getCustomDownloadPath: returns null on mobile even when a legacy custom path exists", () => {
    platformMock.IS_MOBILE = true;
    localStorage.setItem("drplay_download_path", "E:\\Flac");
    expect(getCustomDownloadPath()).toBeNull();
  });

  it("setCustomDownloadPath: no-op on mobile (never persists a folder pick)", () => {
    platformMock.IS_MOBILE = true;
    setCustomDownloadPath("E:\\Flac");
    expect(localStorage.getItem("drplay_download_path")).toBeNull();
  });
});

describe("downloadPath mobile SAF folder (Task 4)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("getMobileDownloadFolder: returns null on desktop (concepts never bleed)", () => {
    platformMock.IS_MOBILE = false;
    localStorage.setItem(
      "drplay_mobile_download_folder",
      JSON.stringify({ uri: "content://tree/x", name: "Download" }),
    );
    expect(getMobileDownloadFolder()).toBeNull();
  });

  it("getMobileDownloadFolder: returns the persisted {uri, name} on mobile", () => {
    platformMock.IS_MOBILE = true;
    localStorage.setItem(
      "drplay_mobile_download_folder",
      JSON.stringify({
        uri: "content://tree/primary%3ADownload",
        name: "Download",
      }),
    );
    expect(getMobileDownloadFolder()).toEqual({
      uri: "content://tree/primary%3ADownload",
      name: "Download",
    });
  });

  it("getMobileDownloadFolder: returns null when nothing is stored", () => {
    platformMock.IS_MOBILE = true;
    expect(getMobileDownloadFolder()).toBeNull();
  });

  it("getMobileDownloadFolder: corrupt JSON → null + warn log (no throw)", () => {
    platformMock.IS_MOBILE = true;
    localStorage.setItem("drplay_mobile_download_folder", "{not json");
    expect(getMobileDownloadFolder()).toBeNull();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "downloadPath",
      message: "mobile-folder-read-failed:SyntaxError",
    });
  });

  it("getMobileDownloadFolder: malformed shape (missing name) → null", () => {
    platformMock.IS_MOBILE = true;
    localStorage.setItem(
      "drplay_mobile_download_folder",
      JSON.stringify({ uri: "content://tree/x" }),
    );
    expect(getMobileDownloadFolder()).toBeNull();
  });

  it("setMobileDownloadFolder: persists the folder JSON on mobile", () => {
    platformMock.IS_MOBILE = true;
    setMobileDownloadFolder({
      uri: "content://tree/primary%3AMusic",
      name: "Music",
    });
    expect(localStorage.getItem("drplay_mobile_download_folder")).toBe(
      JSON.stringify({ uri: "content://tree/primary%3AMusic", name: "Music" }),
    );
  });

  it("setMobileDownloadFolder: no-op on desktop", () => {
    platformMock.IS_MOBILE = false;
    setMobileDownloadFolder({ uri: "content://tree/x", name: "X" });
    expect(localStorage.getItem("drplay_mobile_download_folder")).toBeNull();
  });

  it("clearMobileDownloadFolder: removes the stored folder on mobile", () => {
    platformMock.IS_MOBILE = true;
    setMobileDownloadFolder({ uri: "content://tree/x", name: "X" });
    clearMobileDownloadFolder();
    expect(localStorage.getItem("drplay_mobile_download_folder")).toBeNull();
  });
});
