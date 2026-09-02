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
}));

const mockedInvoke = vi.mocked(invoke);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedGetEffectiveDownloadPath = vi.mocked(getEffectiveDownloadPath);
const mockedGetCustomDownloadPath = vi.mocked(getCustomDownloadPath);
const mockedJoin = vi.mocked(join);

// Minimal TFunction backed by the real en resources: the hook no longer
// passes fallbacks to t(), so a real resource lookup keeps the asserted
// UI strings in sync with the shipped copy.
const t = ((key: string, fallback?: string) => {
  let acc: unknown = en;
  for (const part of key.split(".")) {
    if (typeof acc === "object" && acc !== null) {
      acc = (acc as Record<string, unknown>)[part];
    } else {
      return fallback ?? "";
    }
  }
  return (typeof acc === "string" ? acc : fallback) ?? "";
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
function fetchResolved(bytes: Uint8Array = AUDIO_BYTES): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
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
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockedGetValidToken.mockResolvedValue("test-token");
  mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Downloads");
  mockedGetCustomDownloadPath.mockReturnValue(null);
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

describe("useMenuDownload double-click race guard", () => {
  it("invokes write_file exactly once when Confirm fires twice in the same tick", async () => {
    fetchResolved();
    const { result } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });

    // Keep the first download in flight so the second synchronous call hits
    // the busy-guard while the write has not resolved yet (real double-click:
    // both clicks land before React re-renders).
    let resolveWrite!: () => void;
    mockedInvoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const calls: Array<Promise<void>> = [];
    act(() => {
      calls.push(result.current.executeDownload());
      calls.push(result.current.executeDownload());
    });

    // Flush microtasks so both invocations reach their invoke call.
    await act(async () => {});

    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "plugin:fs|write_file"),
    ).toHaveLength(1);

    resolveWrite();
    await Promise.all(calls);
  });

  it("allows a new download after the previous one finishes", async () => {
    fetchResolved();
    await runDownload();
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "plugin:fs|write_file"),
    ).toHaveLength(1);

    fetchResolved();
    const { result } = renderHook(() => useMenuDownload(t));
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
      mockedInvoke.mock.calls.filter((c) => c[0] === "plugin:fs|write_file"),
    ).toHaveLength(2);
  });
});
