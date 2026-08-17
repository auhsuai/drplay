// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent } from "react";
import type { TFunction } from "i18next";
import type { Track } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { getValidToken } from "../utils/apiClient";
import {
  getEffectiveDownloadPath,
  getCustomDownloadPath,
  getMobileDownloadFolder,
} from "../utils/downloadPath";
import { useMenuDownload } from "./useMenuDownload";
import en from "../locales/en/translation.json";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(),
}));

vi.mock("../utils/downloadPath", () => ({
  getEffectiveDownloadPath: vi.fn(),
  getCustomDownloadPath: vi.fn(),
  getMobileDownloadFolder: vi.fn(),
}));

// IS_MOBILE is read at call time inside the hook, so a getter-backed mock
// lets the same module flip between desktop/mobile.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

const mockedInvoke = vi.mocked(invoke);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedGetEffectiveDownloadPath = vi.mocked(getEffectiveDownloadPath);
const mockedGetCustomDownloadPath = vi.mocked(getCustomDownloadPath);
const mockedGetMobileDownloadFolder = vi.mocked(getMobileDownloadFolder);
const mockedJoin = vi.mocked(join);

// Minimal TFunction backed by the real en resources: the hook no longer
// passes fallbacks to t(), so a real resource lookup keeps the asserted
// UI strings in sync with the shipped copy. Object-form options
// ({ defaultValue }) are honoured for keys not yet present in the JSON
// (mobile-only strings land via defaultValue until the JSON is updated).
const t = ((key: string, fallback?: string | Record<string, unknown>) => {
  const resolveFallback = (): string => {
    if (fallback && typeof fallback === "object") {
      const value = fallback.defaultValue;
      return typeof value === "string" ? value : "";
    }
    return typeof fallback === "string" ? fallback : "";
  };
  let acc: unknown = en;
  for (const part of key.split(".")) {
    if (typeof acc === "object" && acc !== null) {
      acc = (acc as Record<string, unknown>)[part];
    } else {
      return resolveFallback();
    }
  }
  return typeof acc === "string" ? acc : resolveFallback();
}) as unknown as TFunction;

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "file-123",
    title: "Test Song",
    artist: "Test Artist",
    streamUrl: "https://example.com/test-song",
    originalName: "test-song.mp3",
    ...overrides,
  };
}

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

// Resolve the download fetch with the given bytes (jsdom Response lacks
// arrayBuffer() reliably, so the mock stands in for the real Response).
// Headers are included so mobile Content-Length checks work in tests.
function fetchResolved(bytes: Uint8Array = AUDIO_BYTES): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    headers: { get: () => null },
    arrayBuffer: () => {
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      return buf;
    },
  } as unknown as Response);
}

async function runDownload(track: Track = makeTrack()) {
  const { result } = renderHook(() => useMenuDownload(t));
  act(() => {
    result.current.handleDownloadClick(
      { stopPropagation: () => {} } as unknown as MouseEvent,
      track,
      () => {},
    );
  });
  await act(async () => {
    await result.current.executeDownload();
  });
  return result;
}

function writeFileCall(): { bytes: Uint8Array; pathHeader: string } {
  const call = mockedInvoke.mock.calls.find(
    (c) => c[0] === "plugin:fs|write_file",
  );
  expect(call).toBeDefined();
  if (!call) throw new Error("expected a write_file invoke call");
  const headers = call[2] as { headers: { path: string } };
  return { bytes: call[1] as Uint8Array, pathHeader: headers.headers.path };
}

function expectNoWriteFile(): void {
  expect(
    mockedInvoke.mock.calls.some((c) => c[0] === "plugin:fs|write_file"),
  ).toBe(false);
}

beforeEach(() => {
  platformMock.IS_MOBILE = false;
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockedGetValidToken.mockResolvedValue("test-token");
  mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Downloads");
  mockedGetCustomDownloadPath.mockReturnValue(null);
  mockedGetMobileDownloadFolder.mockReturnValue(null);
  // Windows-style separator, matching the pre-upgrade behavior the existing
  // assertions were written against.
  mockedJoin.mockImplementation((dir: string, file: string) =>
    Promise.resolve(`${dir}\\${file}`),
  );
  mockedInvoke.mockImplementation(() => Promise.resolve(undefined));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useMenuDownload writes through plugin:fs|write_file", () => {
  it("saves the file via plugin:fs|write_file with the effective dir and raw bytes (RC2)", async () => {
    fetchResolved();

    await runDownload();

    const { bytes, pathHeader } = writeFileCall();
    expect(pathHeader).toBe(
      encodeURIComponent("C:\\Downloads\\Test Song - Test Artist.mp3"),
    );
    expect(bytes).toEqual(AUDIO_BYTES);
    expect(mockedGetCustomDownloadPath).toHaveBeenCalled();
  });

  it('shows the real save location ("Saved at:") after a successful write', async () => {
    fetchResolved();

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "Saved at: C:\\Downloads\\Test Song - Test Artist.mp3",
    );
  });
});

describe("useMenuDownload custom download path (RC2)", () => {
  it("extends the fs scope via register_download_path BEFORE writing when a custom path is set", async () => {
    mockedGetCustomDownloadPath.mockReturnValue("C:\\Music");
    mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Music");
    fetchResolved();

    await runDownload();

    const registerIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "register_download_path",
    );
    const writeIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "plugin:fs|write_file",
    );
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(registerIdx);
    expect(mockedInvoke.mock.calls[registerIdx]).toEqual([
      "register_download_path",
      { path: "C:\\Music" },
    ]);
    const { pathHeader } = writeFileCall();
    expect(pathHeader).toBe(
      encodeURIComponent("C:\\Music\\Test Song - Test Artist.mp3"),
    );
  });

  it("does NOT call register_download_path when using the default download dir", async () => {
    fetchResolved();

    await runDownload();

    expect(
      mockedInvoke.mock.calls.some((c) => c[0] === "register_download_path"),
    ).toBe(false);
    expect(
      mockedInvoke.mock.calls.some((c) => c[0] === "plugin:fs|write_file"),
    ).toBe(true);
  });

  it("still writes the file when register_download_path fails (scope extend must not block the flow)", async () => {
    mockedGetCustomDownloadPath.mockReturnValue("C:\\Music");
    mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Music");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "register_download_path") {
        return Promise.reject(new Error("scope denied"));
      }
      return Promise.resolve(undefined);
    });
    fetchResolved();

    const result = await runDownload();

    const { pathHeader } = writeFileCall();
    expect(pathHeader).toBe(
      encodeURIComponent("C:\\Music\\Test Song - Test Artist.mp3"),
    );
    expect(result.current.downloadMessage).toContain("Saved at:");
  });
});

describe("useMenuDownload error handling", () => {
  it('shows "Download failed" and does not write when the fetch fails', async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
    expectNoWriteFile();
  });

  it("does not surface a failure message when the download is deliberately aborted (AbortError)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );

    const result = await runDownload();

    expect(result.current.downloadMessage).toBeNull();
    expectNoWriteFile();
  });

  it('shows "Download failed" on a timeout (TimeoutError)', async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("Timed out", "TimeoutError"),
    );

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
    expectNoWriteFile();
  });

  it('shows "Download failed" when the write itself is rejected by the fs plugin', async () => {
    fetchResolved();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin:fs|write_file") {
        return Promise.reject(new Error("file exists"));
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
  });

  it('shows "Download failed" when arrayBuffer() throws RangeError (large file on Android WebView)', async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: () => {
        throw new RangeError("Array buffer allocation failed");
      },
    } as unknown as Response);

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
    expectNoWriteFile();
  });

  it("rejects files exceeding the mobile ArrayBuffer limit when Content-Length is known", async () => {
    platformMock.IS_MOBILE = true;
    // 300 MiB > MOBILE_ARRAY_BUFFER_LIMIT (200 MiB)
    const largeSize = 300 * 1024 * 1024;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: {
        get: (h: string) => (h === "content-length" ? String(largeSize) : null),
      },
      arrayBuffer: () => {
        // Should never be reached — the pre-check should reject first
        throw new RangeError("should not reach arrayBuffer");
      },
    } as unknown as Response);

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
    expectNoWriteFile();
  });

  it("allows files under the mobile ArrayBuffer limit to proceed normally", async () => {
    platformMock.IS_MOBILE = true;
    mockedGetEffectiveDownloadPath.mockResolvedValue(
      "/data/user/0/com.drplay/files",
    );
    mockedJoin.mockImplementation((dir: string, file: string) =>
      Promise.resolve(`${dir}/${file}`),
    );
    // 50 MiB < MOBILE_ARRAY_BUFFER_LIMIT (200 MiB)
    const safeSize = 50 * 1024 * 1024;
    const safeBytes = new Uint8Array(8);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: {
        get: (h: string) => (h === "content-length" ? String(safeSize) : null),
      },
      arrayBuffer: () => {
        const buf = new ArrayBuffer(safeBytes.byteLength);
        new Uint8Array(buf).set(safeBytes);
        return buf;
      },
    } as unknown as Response);

    const result = await runDownload();

    // Should succeed — file is under the limit
    expect(result.current.downloadMessage).toContain("Saved to app storage");
  });

  it("falls through to arrayBuffer() when Content-Length is absent on mobile (chunked transfer)", async () => {
    platformMock.IS_MOBILE = true;
    mockedGetEffectiveDownloadPath.mockResolvedValue(
      "/data/user/0/com.drplay/files",
    );
    mockedJoin.mockImplementation((dir: string, file: string) =>
      Promise.resolve(`${dir}/${file}`),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: () => {
        const buf = new ArrayBuffer(AUDIO_BYTES.byteLength);
        new Uint8Array(buf).set(AUDIO_BYTES);
        return buf;
      },
    } as unknown as Response);

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Saved to app storage");
  });
});

describe("useMenuDownload filename sanitization (RC2)", () => {
  it("sanitizes invalid filename characters in the written path", async () => {
    fetchResolved();

    await runDownload(makeTrack({ title: "A/B:C*", artist: "D?E|F" }));

    const { pathHeader } = writeFileCall();
    expect(pathHeader).toBe(
      encodeURIComponent("C:\\Downloads\\A_B_C_ - D_E_F.mp3"),
    );
  });

  it("trims whitespace-only title/artist to the separator-only name (never an empty write target)", async () => {
    fetchResolved();

    await runDownload(makeTrack({ title: "   ", artist: "  " }));

    const { pathHeader } = writeFileCall();
    expect(pathHeader).toBe(encodeURIComponent("C:\\Downloads\\-.mp3"));
  });
});

describe("useMenuDownload abortable download", () => {
  it("passes an AbortSignal to the download fetch so it can be cancelled (regression: signal was missing)", async () => {
    fetchResolved();

    await runDownload();

    const fetchMock = vi.mocked(fetch);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeDefined();
  });

  it("aborts the in-flight download when the component unmounts", async () => {
    // Never-settling fetch keeps the download "in flight" so the unmount
    // cleanup is the only thing that can stop it.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>(() => {}));

    const { result, unmount } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.executeDownload();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeDefined();
    expect(init?.signal?.aborted).toBe(false);

    unmount();

    expect(init?.signal?.aborted).toBe(true);
    void pending;
  });

  it("bounds the download with AbortSignal.timeout so a stalled server cannot hold the RAM buffer forever", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchResolved();

    await runDownload();

    expect(timeoutSpy).toHaveBeenCalledWith(300_000);
  });
});

describe("useMenuDownload save path building (RC3)", () => {
  it("builds the save path via join() with the platform separator (POSIX regression: no literal backslash)", async () => {
    mockedJoin.mockImplementation((dir: string, file: string) =>
      Promise.resolve(`${dir}/${file}`),
    );
    mockedGetEffectiveDownloadPath.mockResolvedValue("/home/user/Music");
    fetchResolved();

    await runDownload();

    expect(mockedJoin).toHaveBeenCalledWith(
      "/home/user/Music",
      "Test Song - Test Artist.mp3",
    );
    const { pathHeader } = writeFileCall();
    expect(pathHeader).toBe(
      encodeURIComponent("/home/user/Music/Test Song - Test Artist.mp3"),
    );
  });
});

describe("useMenuDownload mobile (IS_MOBILE)", () => {
  it("extends the fs scope to the app dir before writing (mobile has no $DOWNLOAD write scope)", async () => {
    platformMock.IS_MOBILE = true;
    mockedGetEffectiveDownloadPath.mockResolvedValue(
      "/data/user/0/com.drplay/files",
    );
    mockedGetCustomDownloadPath.mockReturnValue(null);
    mockedJoin.mockImplementation((dir: string, file: string) =>
      Promise.resolve(`${dir}/${file}`),
    );
    fetchResolved();

    await runDownload();

    const registerIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "register_download_path",
    );
    const writeIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "plugin:fs|write_file",
    );
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(registerIdx);
    expect(mockedInvoke.mock.calls[registerIdx]).toEqual([
      "register_download_path",
      { path: "/data/user/0/com.drplay/files" },
    ]);
    const { pathHeader } = writeFileCall();
    expect(pathHeader).toBe(
      encodeURIComponent(
        "/data/user/0/com.drplay/files/Test Song - Test Artist.mp3",
      ),
    );
  });

  it("shows the app-storage message on mobile instead of the raw internal path", async () => {
    platformMock.IS_MOBILE = true;
    fetchResolved();

    const result = await runDownload();

    expect(result.current.downloadMessage).toBe("Saved to app storage");
  });
});

describe("useMenuDownload mobile SAF folder (Task 4)", () => {
  const MOBILE_FOLDER = {
    uri: "content://tree/primary%3ADownload",
    name: "Download",
  };
  const APP_DIR = "/data/user/0/com.drplay/files";

  function setupMobileFolder(): void {
    platformMock.IS_MOBILE = true;
    mockedGetEffectiveDownloadPath.mockResolvedValue(APP_DIR);
    mockedGetMobileDownloadFolder.mockReturnValue(MOBILE_FOLDER);
    mockedJoin.mockImplementation((dir: string, file: string) =>
      Promise.resolve(`${dir}/${file}`),
    );
  }

  function saveFileCall(): {
    uri: string;
    fileName: string;
    stagedPath: string;
  } {
    const call = mockedInvoke.mock.calls.find(
      (c) => c[0] === "plugin:saf-download|save_file",
    );
    expect(call).toBeDefined();
    if (!call) throw new Error("expected a saf-download save_file invoke call");
    return call[1] as { uri: string; fileName: string; stagedPath: string };
  }

  it("stages via fs write then hands the staged path to the SAF plugin when a folder is picked", async () => {
    setupMobileFolder();
    fetchResolved();

    const result = await runDownload();

    const writeIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "plugin:fs|write_file",
    );
    const saveIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "plugin:saf-download|save_file",
    );
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(saveIdx).toBeGreaterThan(writeIdx);
    expect(saveFileCall()).toEqual({
      uri: MOBILE_FOLDER.uri,
      fileName: "Test Song - Test Artist.mp3",
      stagedPath: `${APP_DIR}/Test Song - Test Artist.mp3`,
    });
    expect(result.current.downloadMessage).toBe("Saved to Download");
  });

  it("shows the folder-lost message when the persisted SAF permission was revoked", async () => {
    setupMobileFolder();
    fetchResolved();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin:saf-download|save_file") {
        // Real-world rejections from the SAF plugin arrive as {message}
        // objects (PluginResult JSON) — deliberately not an Error.
        return Promise.reject(
          Object.assign(new Error("save_failed:permission_denied"), {
            message: "save_failed:permission_denied",
          }),
        );
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "folder access was revoked",
    );
  });

  it("shows 'Download failed' for a generic SAF write failure", async () => {
    setupMobileFolder();
    fetchResolved();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "plugin:saf-download|save_file") {
        return Promise.reject(new Error("save_failed:create_failed"));
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
  });
});
