// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent } from "react";
import type { TFunction } from "i18next";
import type { Track } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { fetchWithAuth, getValidToken } from "../utils/apiClient";
import {
  getEffectiveDownloadPath,
  getCustomDownloadPath,
} from "../utils/downloadPath";
import { useMenuDownload, type FileDownloadResult } from "./useMenuDownload";
import type { FileDownloadProgressEvent } from "../utils/fileDownload";
import en from "../locales/en/translation.json";

const { MockChannel } = vi.hoisted(() => {
  class MockChannel {
    static instances: MockChannel[] = [];
    onmessage: (event: FileDownloadProgressEvent) => void;
    constructor(onmessage: (event: FileDownloadProgressEvent) => void) {
      this.onmessage = onmessage;
      MockChannel.instances.push(this);
    }
  }
  return { MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: MockChannel,
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

vi.mock("../utils/downloadPath", () => ({
  getEffectiveDownloadPath: vi.fn(),
  getCustomDownloadPath: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedFetchWithAuth = vi.mocked(fetchWithAuth);
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

function metadataResponse(size = "12345", md5Checksum = "abc123") {
  return {
    ok: true,
    json: () => Promise.resolve({ size, md5Checksum }),
  } as unknown as Response;
}

function startCall(): {
  request: Record<string, unknown>;
  channel: InstanceType<typeof MockChannel>;
} {
  const call = mockedInvoke.mock.calls.find(
    (c) => c[0] === "start_file_download",
  );
  expect(call).toBeDefined();
  if (!call) throw new Error("expected a start_file_download invoke call");
  const args = call[1] as {
    request: Record<string, unknown>;
    onProgress: InstanceType<typeof MockChannel>;
  };
  return { request: args.request, channel: args.onProgress };
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

// The hook awaits a chain (token -> metadata -> free space -> join ->
// start) before the Rust command is invoked; one microtask tick is not
// enough to drain it. Drain generously inside act.
async function flushChain() {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  MockChannel.instances = [];
  mockedGetValidToken.mockResolvedValue("test-token");
  mockedFetchWithAuth.mockResolvedValue(metadataResponse());
  mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Downloads");
  mockedGetCustomDownloadPath.mockReturnValue(null);
  // Windows-style separator, matching the pre-upgrade behavior the existing
  // assertions were written against.
  mockedJoin.mockImplementation((dir: string, file: string) =>
    Promise.resolve(`${dir}\\${file}`),
  );
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "file_download_free_space")
      return Promise.resolve(1_000_000_000);
    if (cmd === "start_file_download") {
      return Promise.resolve({
        path: "C:\\Downloads\\Test Song - Test Artist.mp3",
        size: 12345,
        resumed: false,
      });
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useMenuDownload starts a Rust streaming download", () => {
  it("invokes start_file_download with the metadata size/md5 and the joined save path", async () => {
    await runDownload();

    const { request } = startCall();
    expect(request).toMatchObject({
      fileId: "file-123",
      destPath: "C:\\Downloads\\Test Song - Test Artist.mp3",
      token: "test-token",
      expectedSize: 12345,
      md5: "abc123",
    });
    expect(typeof request.downloadId).toBe("string");
    expect(request.downloadId).not.toBe("");
  });

  it('shows the real save location ("Saved to:") after a successful download', async () => {
    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "Saved to: C:\\Downloads\\Test Song - Test Artist.mp3",
    );
  });

  it("reports Channel progress into downloadProgress state", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        // Keep the download in flight so the test can drive progress
        // through the captured Channel before it resolves.
        return new Promise(() => {});
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useMenuDownload(t));
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
    await flushChain();

    const channel = MockChannel.instances[0];
    expect(channel).toBeDefined();
    act(() => {
      channel?.onmessage({
        stage: "downloading",
        downloadId: "dl-1",
        downloaded: 6172,
        total: 12345,
        percent: 50,
        speedBytesPerSec: 1024,
        paused: false,
      });
    });
    expect(result.current.downloadProgress).toMatchObject({
      downloaded: 6172,
      total: 12345,
      percent: 50,
      speedBytesPerSec: 1024,
      stage: "downloading",
      paused: false,
    });

    void pending;
  });
});

describe("useMenuDownload custom download path", () => {
  it("extends the fs scope via register_download_path BEFORE starting when a custom path is set", async () => {
    mockedGetCustomDownloadPath.mockReturnValue("C:\\Music");
    mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Music");

    await runDownload();

    const registerIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "register_download_path",
    );
    const startIdx = mockedInvoke.mock.calls.findIndex(
      (c) => c[0] === "start_file_download",
    );
    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(registerIdx);
    expect(mockedInvoke.mock.calls[registerIdx]).toEqual([
      "register_download_path",
      { path: "C:\\Music" },
    ]);
    expect(startCall().request.destPath).toBe(
      "C:\\Music\\Test Song - Test Artist.mp3",
    );
  });

  it("does NOT call register_download_path when using the default download dir", async () => {
    await runDownload();

    expect(
      mockedInvoke.mock.calls.some((c) => c[0] === "register_download_path"),
    ).toBe(false);
    expect(
      mockedInvoke.mock.calls.some((c) => c[0] === "start_file_download"),
    ).toBe(true);
  });

  it("still starts the download when register_download_path fails (scope extend must not block the flow)", async () => {
    mockedGetCustomDownloadPath.mockReturnValue("C:\\Music");
    mockedGetEffectiveDownloadPath.mockResolvedValue("C:\\Music");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "register_download_path") {
        return Promise.reject(new Error("scope denied"));
      }
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return Promise.resolve({
          path: "C:\\Music\\Test Song - Test Artist.mp3",
          size: 12345,
          resumed: false,
        });
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain("Saved to:");
  });
});

describe("useMenuDownload error handling", () => {
  it("shows the network message and does not start when the Rust command fails with network", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return Promise.reject(new Error("network: a network error occurred"));
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "Couldn't download the file. Check your connection and try again.",
    );
  });

  it("shows the not-found message when the metadata read says the file is gone", async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 404,
    } as unknown as Response);

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "This file is no longer available on Google Drive.",
    );
    expect(
      mockedInvoke.mock.calls.some((c) => c[0] === "start_file_download"),
    ).toBe(false);
  });

  it("refuses to start when the destination has too little free space", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space") return Promise.resolve(10);
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "Not enough free space to save this file.",
    );
    expect(
      mockedInvoke.mock.calls.some((c) => c[0] === "start_file_download"),
    ).toBe(false);
  });

  it("shows the timeout message on an idle-timeout failure", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return Promise.reject(new Error("idle_timeout: the download stalled"));
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "The download stalled and timed out.",
    );
  });

  it("shows the checksum message on a verification failure", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return Promise.reject(
          new Error("checksum_mismatch: the download does not match"),
        );
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "doesn't match the one on Google Drive",
    );
  });

  it("shows the token message when there is no valid token", async () => {
    mockedGetValidToken.mockResolvedValue(null);

    const result = await runDownload();

    expect(result.current.downloadMessage).toContain(
      "Couldn't refresh your Google sign-in.",
    );
    expect(
      mockedInvoke.mock.calls.some((c) => c[0] === "start_file_download"),
    ).toBe(false);
  });

  it("does not surface a failure message when the download is cancelled", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return Promise.reject(
          new Error("cancelled: the download was cancelled"),
        );
      }
      return Promise.resolve(undefined);
    });

    const result = await runDownload();

    expect(result.current.downloadMessage).toBeNull();
  });

  it("still starts when the metadata read fails transiently (falls back to Content-Length)", async () => {
    mockedFetchWithAuth.mockRejectedValue(new Error("network down"));

    const result = await runDownload();

    const { request } = startCall();
    expect(request.expectedSize).toBeNull();
    expect(request.md5).toBeNull();
    expect(result.current.downloadMessage).toContain("Saved to:");
  });
});

describe("useMenuDownload filename sanitization", () => {
  it("sanitizes invalid filename characters in the save path", async () => {
    await runDownload(makeTrack({ title: "A/B:C*", artist: "D?E|F" }));

    expect(startCall().request.destPath).toBe(
      "C:\\Downloads\\A_B_C_ - D_E_F.mp3",
    );
  });

  it("trims whitespace-only title/artist to the separator-only name (never an empty write target)", async () => {
    await runDownload(makeTrack({ title: "   ", artist: "  " }));

    expect(startCall().request.destPath).toBe("C:\\Downloads\\-.mp3");
  });
});

describe("useMenuDownload cancel / pause / resume", () => {
  it("cancels the in-flight download through cancel_file_download with the same id", async () => {
    let rejectStart!: (err: Error) => void;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return new Promise<FileDownloadResult>((_resolve, reject) => {
          rejectStart = reject;
        });
      }
      return Promise.resolve(undefined);
    });
    const { result } = renderHook(() => useMenuDownload(t));
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
    await flushChain();

    const { request } = startCall();
    await act(async () => {
      await result.current.cancelDownload();
    });

    const cancelCall = mockedInvoke.mock.calls.find(
      (c) => c[0] === "cancel_file_download",
    );
    expect(cancelCall?.[1]).toEqual({ downloadId: request.downloadId });

    // The Rust command then rejects with cancelled; the hook stays silent.
    await act(async () => {
      rejectStart(new Error("cancelled: the download was cancelled"));
      await pending;
    });
    expect(result.current.downloadMessage).toBeNull();
  });

  it("pauses and resumes through the matching commands", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return new Promise(() => {});
      }
      return Promise.resolve(true);
    });
    const { result } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });
    act(() => {
      void result.current.executeDownload();
    });
    await flushChain();

    const { request } = startCall();
    await act(async () => {
      await result.current.pauseDownload();
    });
    expect(mockedInvoke.mock.calls).toContainEqual([
      "pause_file_download",
      { downloadId: request.downloadId },
    ]);
    expect(result.current.downloadPaused).toBe(true);

    await act(async () => {
      await result.current.resumeDownload();
    });
    expect(mockedInvoke.mock.calls).toContainEqual([
      "resume_file_download",
      { downloadId: request.downloadId },
    ]);
    expect(result.current.downloadPaused).toBe(false);
  });

  it("cancels the in-flight download when the component unmounts", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return new Promise(() => {});
      }
      return Promise.resolve(undefined);
    });
    const { result, unmount } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });
    act(() => {
      void result.current.executeDownload();
    });
    await flushChain();

    const { request } = startCall();
    unmount();

    expect(mockedInvoke.mock.calls).toContainEqual([
      "cancel_file_download",
      { downloadId: request.downloadId },
    ]);
  });
});

describe("useMenuDownload save path building", () => {
  it("builds the save path via join() with the platform separator (POSIX regression: no literal backslash)", async () => {
    mockedJoin.mockImplementation((dir: string, file: string) =>
      Promise.resolve(`${dir}/${file}`),
    );
    mockedGetEffectiveDownloadPath.mockResolvedValue("/home/user/Music");

    await runDownload();

    expect(mockedJoin).toHaveBeenCalledWith(
      "/home/user/Music",
      "Test Song - Test Artist.mp3",
    );
    expect(startCall().request.destPath).toBe(
      "/home/user/Music/Test Song - Test Artist.mp3",
    );
  });
});

describe("useMenuDownload double-click race guard", () => {
  it("invokes start_file_download exactly once when Confirm fires twice in the same tick", async () => {
    const { result } = renderHook(() => useMenuDownload(t));
    act(() => {
      result.current.handleDownloadClick(
        { stopPropagation: () => {} } as unknown as MouseEvent,
        makeTrack(),
        () => {},
      );
    });

    // Keep the first download in flight so the second synchronous call hits
    // the busy-guard while the start has not resolved yet (real double-click:
    // both clicks land before React re-renders).
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "file_download_free_space")
        return Promise.resolve(1_000_000_000);
      if (cmd === "start_file_download") {
        return new Promise(() => {});
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
      mockedInvoke.mock.calls.filter((c) => c[0] === "start_file_download"),
    ).toHaveLength(1);
    void calls;
  });

  it("allows a new download after the previous one finishes", async () => {
    await runDownload();
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "start_file_download"),
    ).toHaveLength(1);

    await runDownload(makeTrack({ id: "file-456", title: "Second Song" }));

    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "start_file_download"),
    ).toHaveLength(2);
  });
});
