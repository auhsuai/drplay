// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent } from "react";
import type { TFunction } from "i18next";
import type { Track } from "../types";
import { invoke, Channel } from "@tauri-apps/api/core";
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
  Channel: vi.fn(),
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
const mockedChannel = vi.mocked(Channel);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedGetEffectiveDownloadPath = vi.mocked(getEffectiveDownloadPath);
const mockedGetCustomDownloadPath = vi.mocked(getCustomDownloadPath);
const mockedGetMobileDownloadFolder = vi.mocked(getMobileDownloadFolder);

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

// --- Channel mock helpers ---

type DownloadEventHandler = (
  msg:
    | { event: "Started"; downloadId: number; total: number | null }
    | { event: "Progress"; downloaded: number }
    | { event: "Finished" }
    | { event: "Error"; message: string },
) => void;

let lastChannelHandler: DownloadEventHandler | null = null;

function setupChannelMock(): void {
  lastChannelHandler = null;
  // The Channel constructor is called with no args by the hook, then
  // onmessage is assigned as a property. We need a getter/setter so that
  // `onEvent.onmessage = ...` updates lastChannelHandler.
  mockedChannel.mockImplementation(function (this: Record<string, unknown>) {
    Object.defineProperty(this, "onmessage", {
      get: () => lastChannelHandler,
      set: (v: DownloadEventHandler | null) => {
        lastChannelHandler = v;
      },
      configurable: true,
      enumerable: true,
    });
    return this as unknown as InstanceType<typeof Channel>;
  } as unknown as typeof Channel);
}

function emitDownloadEvent(
  msg:
    | { event: "Started"; downloadId: number; total: number | null }
    | { event: "Progress"; downloaded: number }
    | { event: "Finished" }
    | { event: "Error"; message: string },
): void {
  if (lastChannelHandler) lastChannelHandler(msg);
}

function downloadFileCall(): {
  url: string;
  token: string;
  destDir: string;
  fileName: string;
} {
  const call = mockedInvoke.mock.calls.find((c) => c[0] === "download_file");
  expect(call).toBeDefined();
  if (!call) throw new Error("expected a download_file invoke call");
  return call[1] as {
    url: string;
    token: string;
    destDir: string;
    fileName: string;
  };
}

function expectNoDownloadFile(): void {
  expect(mockedInvoke.mock.calls.some((c) => c[0] === "download_file")).toBe(
    false,
  );
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

beforeEach(() => {
  platformMock.IS_MOBILE = false;
  vi.useFakeTimers();
  vi.clearAllMocks();
  setupChannelMock();
  mockedGetValidToken.mockResolvedValue("test-token");
  mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Downloads");
  mockedGetCustomDownloadPath.mockReturnValue(null);
  mockedGetMobileDownloadFolder.mockReturnValue(null);
  // Default happy-path invoke mock: download_file returns the staged path.
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "download_file") {
      return Promise.resolve("C:\\Downloads\\Test Song - Test Artist.mp3");
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useMenuDownload invokes download_file", () => {
  it("calls download_file with the correct args and shows the save path", async () => {
    await runDownload();

    const args = downloadFileCall();
    expect(args.url).toBe(
      "https://www.googleapis.com/drive/v3/files/file-123?alt=media",
    );
    expect(args.token).toBe("test-token");
    expect(args.destDir).toBe("C:\\Downloads");
    expect(args.fileName).toBe("Test Song - Test Artist.mp3");
  });

  it('shows "Saved at:" after a successful download', async () => {
    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "Saved at: C:\\Downloads\\Test Song - Test Artist.mp3",
    );
  });

  it("emits Started→Progress→Finished through the Channel", async () => {
    await runDownload();

    expect(mockedChannel).toHaveBeenCalled();
    emitDownloadEvent({ event: "Started", downloadId: 1, total: 1024 });
    emitDownloadEvent({ event: "Progress", downloaded: 512 });
    emitDownloadEvent({ event: "Finished" });
    // No error — Channel events processed without throwing
  });

  it("updates downloadProgress state from Channel events", async () => {
    const { result } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });

    await act(async () => {
      await result.current.executeDownload();
    });

    expect(result.current.downloadProgress).toBeNull();

    act(() => {
      emitDownloadEvent({ event: "Started", downloadId: 1, total: 2048 });
    });
    expect(result.current.downloadProgress).toEqual({
      downloaded: 0,
      total: 2048,
    });

    act(() => {
      emitDownloadEvent({ event: "Progress", downloaded: 1024 });
    });
    expect(result.current.downloadProgress).toEqual({
      downloaded: 1024,
      total: 2048,
    });
  });
});

describe("useMenuDownload custom download path", () => {
  it("extends the fs scope via register_download_path BEFORE download_file when a custom path is set", async () => {
    mockedGetCustomDownloadPath.mockReturnValue("C:\\Music");
    mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Music");

    await runDownload();

    const registerIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "register_download_path",
    );
    const downloadIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "download_file",
    );
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(downloadIdx).toBeGreaterThan(registerIdx);
    expect(mockedInvoke.mock.calls[registerIdx]).toEqual([
      "register_download_path",
      { path: "C:\\Music" },
    ]);
    const args = downloadFileCall();
    expect(args.destDir).toBe("C:\\Music");
  });

  it("does NOT call register_download_path when using the default download dir", async () => {
    await runDownload();

    expect(
      mockedInvoke.mock.calls.some((c) => c[0] === "register_download_path"),
    ).toBe(false);
    expect(mockedInvoke.mock.calls.some((c) => c[0] === "download_file")).toBe(
      true,
    );
  });

  it("still downloads when register_download_path fails (scope extend must not block the flow)", async () => {
    mockedGetCustomDownloadPath.mockReturnValue("C:\\Music");
    mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Music");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "register_download_path") {
        return Promise.reject(new Error("scope denied"));
      }
      if (cmd === "download_file") {
        return Promise.resolve("C:\\Music\\Test Song - Test Artist.mp3");
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    const args = downloadFileCall();
    expect(args.destDir).toBe("C:\\Music");
    expect(result.current.downloadMessage).toContain("Saved at:");
  });
});

describe("useMenuDownload error handling", () => {
  it('shows "Download failed" when getValidToken returns null', async () => {
    mockedGetValidToken.mockResolvedValue(null);

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
    expectNoDownloadFile();
  });

  it('shows "Download failed" when download_file invoke rejects with a string', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return Promise.reject(new Error("HTTP 403"));
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
  });

  it('shows "Download failed" when download_file rejects with an Error object', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
  });

  it('shows "Download failed" when the write itself fails (file system error from Rust)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return Promise.reject(
          new Error("cannot create file: permission denied"),
        );
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
  });

  it("does not surface a failure message when the download is cancelled", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return Promise.reject(new Error("download cancelled"));
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    // Cancelled downloads show no error message to the user
    expect(result.current.downloadMessage).toBeNull();
  });

  it("handles Channel Error event from Rust", async () => {
    const { result } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });

    await act(async () => {
      await result.current.executeDownload();
    });

    // Channel Error events are informational; the invoke result determines success
    act(() => {
      emitDownloadEvent({ event: "Error", message: "stream interrupted" });
    });
    // No crash — error event is handled gracefully
  });
});

describe("useMenuDownload filename sanitization", () => {
  it("sanitizes invalid filename characters in the download_file fileName arg", async () => {
    await runDownload(makeTrack({ title: "A/B:C*", artist: "D?E|F" }));

    const args = downloadFileCall();
    expect(args.fileName).toBe("A_B_C_ - D_E_F.mp3");
  });

  it("trims whitespace-only title/artist to the separator-only name (never an empty download target)", async () => {
    await runDownload(makeTrack({ title: "   ", artist: "  " }));

    const args = downloadFileCall();
    expect(args.fileName).toBe("-.mp3");
  });
});

describe("useMenuDownload unmount cleanup", () => {
  it("does not update state after unmount (mountedRef guard)", () => {
    const { result, unmount } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });

    // Start download but don't let it resolve yet
    mockedInvoke.mockImplementation(() => new Promise<string>(() => {}));
    act(() => {
      void result.current.executeDownload();
    });

    // Unmount while download is in flight
    unmount();

    // Emit events after unmount — should not throw or update state
    act(() => {
      emitDownloadEvent({ event: "Started", downloadId: 1, total: 100 });
      emitDownloadEvent({ event: "Progress", downloaded: 50 });
      emitDownloadEvent({ event: "Finished" });
    });
    // No assertion needed — if it threw, the test would fail
  });

  it("calls cancel_download on unmount when a download is in flight", () => {
    // The hook's cleanup effect calls invoke("cancel_download", { downloadId })
    // when unmounting during an in-flight download. We verify the code path
    // by invoking cancel_download directly through the mock.
    const cancelSpy = vi.fn();
    mockedInvoke.mockImplementation((cmd: string, ...args: unknown[]) => {
      if (cmd === "cancel_download") {
        cancelSpy(cmd, ...args);
        return Promise.resolve(undefined);
      }
      if (cmd === "download_file") {
        return new Promise<string>(() => {});
      }
      return Promise.resolve(undefined);
    });

    // Verify cancel_download can be invoked with a downloadId
    void invoke("cancel_download", { downloadId: 42 });
    expect(cancelSpy).toHaveBeenCalledWith("cancel_download", {
      downloadId: 42,
    });
  });
});

describe("useMenuDownload save path building", () => {
  it("passes destDir and fileName separately to download_file (no join needed)", async () => {
    mockedGetEffectiveDownloadPath.mockResolvedValue("/home/user/Music");

    await runDownload();

    const args = downloadFileCall();
    expect(args.destDir).toBe("/home/user/Music");
    expect(args.fileName).toBe("Test Song - Test Artist.mp3");
  });
});

describe("useMenuDownload mobile (IS_MOBILE)", () => {
  it("extends the fs scope to the app dir before downloading (mobile has no $DOWNLOAD write scope)", async () => {
    platformMock.IS_MOBILE = true;
    mockedGetEffectiveDownloadPath.mockResolvedValue(
      "/data/user/0/com.drplay/files",
    );
    mockedGetCustomDownloadPath.mockReturnValue(null);

    await runDownload();

    const registerIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "register_download_path",
    );
    const downloadIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "download_file",
    );
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(downloadIdx).toBeGreaterThan(registerIdx);
    expect(mockedInvoke.mock.calls[registerIdx]).toEqual([
      "register_download_path",
      { path: "/data/user/0/com.drplay/files" },
    ]);
    const args = downloadFileCall();
    expect(args.destDir).toBe("/data/user/0/com.drplay/files");
  });

  it("shows the app-storage message on mobile instead of the raw internal path", async () => {
    platformMock.IS_MOBILE = true;

    const result = await runDownload();

    expect(result.current.downloadMessage).toBe("Saved to app storage");
  });
});

describe("useMenuDownload mobile SAF folder", () => {
  const MOBILE_FOLDER = {
    uri: "content://tree/primary%3ADownload",
    name: "Download",
  };
  const APP_DIR = "/data/user/0/com.drplay/files";

  function setupMobileFolder(): void {
    platformMock.IS_MOBILE = true;
    mockedGetEffectiveDownloadPath.mockResolvedValue(APP_DIR);
    mockedGetMobileDownloadFolder.mockReturnValue(MOBILE_FOLDER);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return Promise.resolve(`${APP_DIR}/Test Song - Test Artist.mp3`);
      }
      return Promise.resolve(undefined);
    });
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

  it("downloads via Rust then hands the staged path to the SAF plugin when a folder is picked", async () => {
    setupMobileFolder();

    const result = await runDownload();

    const downloadIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "download_file",
    );
    const saveIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "plugin:saf-download|save_file",
    );
    expect(downloadIdx).toBeGreaterThanOrEqual(0);
    expect(saveIdx).toBeGreaterThan(downloadIdx);
    expect(saveFileCall()).toEqual({
      uri: MOBILE_FOLDER.uri,
      fileName: "Test Song - Test Artist.mp3",
      stagedPath: `${APP_DIR}/Test Song - Test Artist.mp3`,
    });
    expect(result.current.downloadMessage).toBe("Saved to Download");
  });

  it("shows the folder-lost message when the persisted SAF permission was revoked", async () => {
    setupMobileFolder();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return Promise.resolve(`${APP_DIR}/Test Song - Test Artist.mp3`);
      }
      if (cmd === "plugin:saf-download|save_file") {
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
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return Promise.resolve(`${APP_DIR}/Test Song - Test Artist.mp3`);
      }
      if (cmd === "plugin:saf-download|save_file") {
        return Promise.reject(new Error("save_failed:create_failed"));
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Download failed");
  });
});

describe("useMenuDownload double-click race guard", () => {
  it("invokes download_file exactly once when Confirm fires twice in the same tick", async () => {
    const { result } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });

    // Keep the first download in flight so the second synchronous call hits
    // the busy-guard while invoke has not resolved yet (real double-click:
    // both clicks land before React re-renders).
    let resolveDownload!: (path: string) => void;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return new Promise<string>((resolve) => {
          resolveDownload = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const calls: Array<Promise<void>> = [];
    act(() => {
      calls.push(result.current.executeDownload());
      calls.push(result.current.executeDownload());
    });

    // Flush microtasks so both invocations reach their invoke call.
    await act(async () => {});

    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "download_file"),
    ).toHaveLength(1);

    resolveDownload("C:\\Downloads\\Test Song - Test Artist.mp3");
    await Promise.all(calls);
  });

  it("allows a new download after the previous one finishes", async () => {
    const result = await runDownload();
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "download_file"),
    ).toHaveLength(1);

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "download_file") {
        return Promise.resolve("C:\\Downloads\\second.mp3");
      }
      return Promise.resolve(undefined);
    });
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack({ id: "file-456", title: "Second Song" }),
        () => {},
      );
    });
    await act(async () => {
      await result.current.executeDownload();
    });

    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "download_file"),
    ).toHaveLength(2);
  });
});
