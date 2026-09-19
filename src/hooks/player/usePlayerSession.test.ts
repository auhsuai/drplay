// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "../../db/kv";
import { getValidToken } from "../../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";
import { usePlayerSession } from "./usePlayerSession";
import { PLAYER_STOP_EVENT } from "./usePlayerLifecycle";
import { clearRestoreResume, consumeRestoreResume } from "./restoreResume";
import { usePlayerStore } from "../../store/playerStore";
import type { Track } from "../../types";

vi.mock("../../db/kv", () => ({
  get: vi.fn(),
}));

vi.mock("../../utils/apiClient", () => ({
  getValidToken: vi.fn(),
}));

vi.mock("../../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(),
  DRIVE_STREAM_PREFIX: "/drive-stream/",
  buildStreamUrl: vi.fn(
    (fileId: string, name?: string) =>
      `/drive-stream/${fileId}${name ? "?ext=flac" : ""}`,
  ),
}));

vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const audioMock = vi.hoisted(() => ({
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 0),
  getCurrentTrackId: vi.fn(() => "t1"),
  on: vi.fn<(event: string, handler: () => void) => () => void>(() => () => {}),
}));

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

vi.mock("../../store/playerStore", () => ({
  usePlayerStore: { getState: vi.fn(() => ({ currentTrack: null })) },
}));

const mockedGet = vi.mocked(get);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedGetPrefetchedStreamUrl = vi.mocked(getPrefetchedStreamUrl);
const mockedBuildStreamUrl = vi.mocked(buildStreamUrl);
const mockedCaptureError = vi.mocked(captureError);

const SESSION_STORAGE_KEY = "drplay_last_session";
const QUEUE_STORAGE_KEY = "drplay_queue";
const PLAYMODE_STORAGE_KEY = "drplay_playmode";

function makeTrack(id: string, queueItemId?: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: "Artist",
    streamUrl: `https://stream.example/${id}`,
    ...(queueItemId ? { queueItemId } : {}),
  };
}

function makeHook() {
  const setCurrentTrack = vi.fn();
  const setOriginalQueue = vi.fn();
  const setPlaybackQueue = vi.fn();
  const setPlayMode = vi.fn();
  const triggerReload = vi.fn();
  const onHydrated = vi.fn();
  renderHook(() => {
    usePlayerSession(
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
      onHydrated,
    );
  });
  return {
    setCurrentTrack,
    setOriginalQueue,
    setPlaybackQueue,
    setPlayMode,
    triggerReload,
    onHydrated,
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearRestoreResume();
  mockedGet.mockResolvedValue(undefined);
  mockedGetValidToken.mockResolvedValue("test-token");
  mockedGetPrefetchedStreamUrl.mockReturnValue(undefined);
  // Default store state cho mọi test (tránh leak mockReturnValue giữa các test —
  // guard restore đọc getState() nên cần giá trị khởi tạo thật của store).
  vi.mocked(usePlayerStore.getState).mockReturnValue({
    currentTrack: null,
    isDownloading: false,
  } as unknown as ReturnType<typeof usePlayerStore.getState>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePlayerSession restore (lock-behavior)", () => {
  it("A: không có session (localStorage rỗng + kv null) → không set state, không reload", async () => {
    makeHook();
    await flushMicrotasks();

    expect(mockedGet).toHaveBeenCalledWith(SESSION_STORAGE_KEY);
    expect(mockedGetValidToken).not.toHaveBeenCalled();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("A2: không có session → onHydrated vẫn fire đúng 1 lần (gate mở, không deadlock persist) — F7-1", async () => {
    const { onHydrated } = makeHook();
    await flushMicrotasks();

    expect(onHydrated).toHaveBeenCalledTimes(1);
  });

  it("B: có session localStorage + kv queue + playmode shuffle → restore track + queue shuffle qua helper (head = restored track, đủ phần tử)", async () => {
    const queue = [
      makeTrack("t1", "q1"),
      makeTrack("t2", "q2"),
      makeTrack("t3", "q3"),
    ];
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: queue[0], time: 12, duration: 240 }),
    );
    mockedGet.mockImplementation((key: string) => {
      if (key === QUEUE_STORAGE_KEY) return Promise.resolve(queue);
      if (key === PLAYMODE_STORAGE_KEY) return Promise.resolve("shuffle");
      return Promise.resolve(undefined);
    });

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    // Deterministic Fisher-Yates: Math.random=0 → shuffle = reverse, cho queue còn lại [t2,t3]
    vi.spyOn(Math, "random").mockReturnValue(0);
    await flushMicrotasks();

    const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
    expect(restored.id).toBe("t1");
    expect(restored.streamUrl).toBe("/drive-stream/t1");
    expect(restored.restoreTime).toBe(12);
    expect(restored.restoreDuration).toBe(240);
    expect(restored.queueItemId).toBe("q1");

    expect(setOriginalQueue).toHaveBeenCalledWith(queue);

    const shuffled = setPlaybackQueue.mock.calls[0]?.[0] as Track[];
    expect(shuffled).toHaveLength(3);
    expect(shuffled[0]).toBe(queue[0]);
    expect(shuffled.map((t) => t.id)).toEqual(["t1", "t3", "t2"]);

    expect(setPlayMode).toHaveBeenCalledWith("shuffle");
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });

  it("C: abort giữa restore (getValidToken reject AbortError) → không set state, không captureError", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGetValidToken.mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();

    expect(setCurrentTrack).not.toHaveBeenCalled();
    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlaybackQueue).not.toHaveBeenCalled();
    expect(setPlayMode).not.toHaveBeenCalled();
    expect(triggerReload).not.toHaveBeenCalled();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("D: session corrupt (JSON sai) → fallback kv + vẫn restore đủ, không crash", async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, "not-valid-json{{{");
    const session = { track: makeTrack("t1", "q1"), time: 9, duration: 90 };
    mockedGet.mockImplementation((key: string) => {
      if (key === SESSION_STORAGE_KEY) return Promise.resolve(session);
      return Promise.resolve(undefined);
    });

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: expect.stringContaining(
          "session-corrupt",
        ) as unknown as string,
      }),
    );

    const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
    expect(restored.id).toBe("t1");
    expect(restored.restoreTime).toBe(9);
    expect(restored.restoreDuration).toBe(90);

    const playback = setPlaybackQueue.mock.calls[0]?.[0] as Track[];
    expect(playback).toHaveLength(1);
    expect(playback[0]?.id).toBe("t1");

    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlayMode).not.toHaveBeenCalled();
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });
});

describe("usePlayerSession restore resume hint (F7-6/F8-8)", () => {
  it("Q: restore có time → arm ONE-SHOT resume hint, consume đúng 1 lần", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 12, duration: 240 }),
    );
    mockedGet.mockResolvedValue(undefined);

    const { setCurrentTrack } = makeHook();
    await flushMicrotasks();

    expect(setCurrentTrack).toHaveBeenCalledTimes(1);
    expect(consumeRestoreResume("t1")).toBe(12);
    expect(consumeRestoreResume("t1")).toBeUndefined();
  });

  it("R: restore không có time → không arm hint", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        track: makeTrack("t1", "q1"),
        duration: 240,
      }),
    );
    mockedGet.mockResolvedValue(undefined);

    const { setCurrentTrack } = makeHook();
    await flushMicrotasks();

    expect(setCurrentTrack).toHaveBeenCalledTimes(1);
    expect(consumeRestoreResume("t1")).toBeUndefined();
  });
});

describe("usePlayerSession restore URL (buildStreamUrl delegation)", () => {
  it("I: originalName playable (flac) → streamUrl qua buildStreamUrl(id, originalName) mang ?ext=", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        track: { ...makeTrack("t1", "q1"), originalName: "song.flac" },
        time: 12,
        duration: 240,
      }),
    );
    mockedGet.mockResolvedValue(undefined);

    const { setCurrentTrack, triggerReload } = makeHook();
    await flushMicrotasks();

    expect(mockedBuildStreamUrl).toHaveBeenCalledWith("t1", "song.flac");
    const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
    expect(restored.streamUrl).toBe("/drive-stream/t1?ext=flac");
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });

  it("J: originalName không có → streamUrl qua buildStreamUrl không mang ?ext=", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 12, duration: 240 }),
    );
    mockedGet.mockResolvedValue(undefined);

    const { setCurrentTrack, triggerReload } = makeHook();
    await flushMicrotasks();

    expect(mockedBuildStreamUrl).toHaveBeenCalledWith("t1", undefined);
    const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
    expect(restored.streamUrl).toBe("/drive-stream/t1");
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });
});

describe("usePlayerSession upgrades (new lock/guard tests)", () => {
  it("E: kv playmode rác → setPlayMode không gọi với giá trị rác + captureError session-playmode-corrupt (UPGRADE 3)", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGet.mockImplementation((key: string) => {
      if (key === PLAYMODE_STORAGE_KEY) return Promise.resolve("rubbish");
      return Promise.resolve(undefined);
    });

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();

    expect(setPlayMode).not.toHaveBeenCalled();
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: expect.stringContaining(
          "session-playmode-corrupt",
        ) as unknown as string,
      }),
    );
    expect(setCurrentTrack).toHaveBeenCalledTimes(1);
    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlaybackQueue).toHaveBeenCalledTimes(1);
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });

  it("F: pagehide listener được đăng ký cùng beforeunload + remove đối xứng khi unmount (UPGRADE 4)", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => {
      usePlayerSession(vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn());
    });

    expect(addSpy.mock.calls.some((c) => c[0] === "beforeunload")).toBe(true);
    expect(addSpy.mock.calls.some((c) => c[0] === "pagehide")).toBe(true);

    unmount();
    expect(removeSpy.mock.calls.some((c) => c[0] === "beforeunload")).toBe(
      true,
    );
    expect(removeSpy.mock.calls.some((c) => c[0] === "pagehide")).toBe(true);
  });

  it("G: localStorage.setItem throw → captureError session-save-fail, không crash (UPGRADE 2)", () => {
    vi.mocked(usePlayerStore.getState).mockReturnValue({
      currentTrack: makeTrack("t1", "q1"),
    } as unknown as ReturnType<typeof usePlayerStore.getState>);
    vi.mocked(audioMock.getCurrentTime).mockReturnValue(10);
    vi.mocked(audioMock.getDuration).mockReturnValue(240);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    makeHook();
    const pauseHandler = audioMock.on.mock.calls.find(
      (c) => c[0] === "pause",
    )?.[1];
    expect(pauseHandler).toBeTypeOf("function");
    act(() => {
      pauseHandler?.();
    });

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "usePlayerSession",
        message: expect.stringContaining(
          "session-save-fail",
        ) as unknown as string,
      }),
    );
  });

  it("H: kv get queue throw → không set state nào + captureError session-load-failed (lock UPGRADE 6)", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGet.mockImplementation((key: string) => {
      if (key === QUEUE_STORAGE_KEY)
        return Promise.reject(new Error("idb fail"));
      return Promise.resolve(undefined);
    });

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();

    expect(setCurrentTrack).not.toHaveBeenCalled();
    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlaybackQueue).not.toHaveBeenCalled();
    expect(setPlayMode).not.toHaveBeenCalled();
    expect(triggerReload).not.toHaveBeenCalled();
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "usePlayerSession",
        message: expect.stringContaining(
          "session-load-failed",
        ) as unknown as string,
      }),
    );
  });
});

describe("usePlayerSession queue element validation (B16-4)", () => {
  it("K: queue [null] + shuffle → drop invalid, không crash, restore track hợp lệ vẫn chạy", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGet.mockImplementation((key: string) => {
      if (key === QUEUE_STORAGE_KEY) return Promise.resolve([null]);
      if (key === PLAYMODE_STORAGE_KEY) return Promise.resolve("shuffle");
      return Promise.resolve(undefined);
    });

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: "session-queue-dropped-invalid: 1",
      }),
    );
    expect(setOriginalQueue).not.toHaveBeenCalled();
    const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
    expect(restored.id).toBe("t1");
    const playback = setPlaybackQueue.mock.calls[0]?.[0] as Track[];
    expect(playback).toHaveLength(1);
    expect(playback[0]).toBe(restored);
    expect(setPlayMode).toHaveBeenCalledWith("shuffle");
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });

  it.each([42, "rubbish", {}])(
    "L: queue [%j] không phải object có id string → drop + không set originalQueue",
    async (rubbish) => {
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          track: makeTrack("t1", "q1"),
          time: 5,
          duration: 100,
        }),
      );
      mockedGet.mockImplementation((key: string) => {
        if (key === QUEUE_STORAGE_KEY) return Promise.resolve([rubbish]);
        return Promise.resolve(undefined);
      });

      const {
        setCurrentTrack,
        setOriginalQueue,
        setPlaybackQueue,
        triggerReload,
      } = makeHook();
      await flushMicrotasks();

      expect(mockedCaptureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "playerPersistence",
          message: "session-queue-dropped-invalid: 1",
        }),
      );
      expect(setOriginalQueue).not.toHaveBeenCalled();
      const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
      expect(restored.id).toBe("t1");
      const playback = setPlaybackQueue.mock.calls[0]?.[0] as Track[];
      expect(playback).toHaveLength(1);
      expect(playback[0]).toBe(restored);
      expect(triggerReload).toHaveBeenCalledTimes(1);
    },
  );

  it("M: queue [rác, track hợp lệ] → filter giữ nguyên reference track hợp lệ", async () => {
    const valid = makeTrack("t2", "q2");
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGet.mockImplementation((key: string) => {
      if (key === QUEUE_STORAGE_KEY) return Promise.resolve([null, valid]);
      return Promise.resolve(undefined);
    });

    const { setOriginalQueue, setPlaybackQueue, triggerReload } = makeHook();
    await flushMicrotasks();

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: "session-queue-dropped-invalid: 1",
      }),
    );
    const original = setOriginalQueue.mock.calls[0]?.[0] as Track[];
    expect(original).toHaveLength(1);
    expect(original[0]).toBe(valid);
    const playback = setPlaybackQueue.mock.calls[0]?.[0] as Track[];
    expect(playback).toHaveLength(1);
    expect(playback[0]).toBe(valid);
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });
});

describe("usePlayerSession restore race (user intent guard)", () => {
  it("N: user click bài trong lúc restore đang await → bỏ toàn bộ commit (queue + track)", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGet.mockResolvedValue(undefined);
    let resolveToken: (token: string) => void = () => {};
    mockedGetValidToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();
    expect(mockedGetValidToken).toHaveBeenCalledTimes(1);

    // user click bài khác trong lúc restore còn chờ token
    vi.mocked(usePlayerStore.getState).mockReturnValue({
      currentTrack: makeTrack("user-click"),
      isDownloading: false,
    } as unknown as ReturnType<typeof usePlayerStore.getState>);

    resolveToken("test-token");
    await flushMicrotasks();

    expect(setCurrentTrack).not.toHaveBeenCalled();
    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlaybackQueue).not.toHaveBeenCalled();
    expect(setPlayMode).not.toHaveBeenCalled();
    expect(triggerReload).not.toHaveBeenCalled();
    expect(mockedCaptureError).not.toHaveBeenCalled();
    // An aborted restore must not leave a resume hint armed for a track it
    // never committed (F7-6/F8-8).
    expect(consumeRestoreResume("t1")).toBeUndefined();
  });

  it("O: user đang load (isDownloading=true) khi restore resolve → bỏ toàn bộ commit", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGet.mockResolvedValue(undefined);
    let resolveToken: (token: string) => void = () => {};
    mockedGetValidToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();
    expect(mockedGetValidToken).toHaveBeenCalledTimes(1);

    // user vừa bắt đầu một lượt load (isDownloading) trong lúc restore await
    vi.mocked(usePlayerStore.getState).mockReturnValue({
      currentTrack: null,
      isDownloading: true,
    } as unknown as ReturnType<typeof usePlayerStore.getState>);

    resolveToken("test-token");
    await flushMicrotasks();

    expect(setCurrentTrack).not.toHaveBeenCalled();
    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlaybackQueue).not.toHaveBeenCalled();
    expect(setPlayMode).not.toHaveBeenCalled();
    expect(triggerReload).not.toHaveBeenCalled();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("P: user không tương tác (currentTrack=null, isDownloading=false) → restore commit đủ như cũ", async () => {
    const queue = [makeTrack("t1", "q1"), makeTrack("t2", "q2")];
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: queue[0], time: 7, duration: 120 }),
    );
    mockedGet.mockImplementation((key: string) => {
      if (key === QUEUE_STORAGE_KEY) return Promise.resolve(queue);
      if (key === PLAYMODE_STORAGE_KEY) return Promise.resolve("normal");
      return Promise.resolve(undefined);
    });
    vi.mocked(usePlayerStore.getState).mockReturnValue({
      currentTrack: null,
      isDownloading: false,
    } as unknown as ReturnType<typeof usePlayerStore.getState>);

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();

    expect(setOriginalQueue).toHaveBeenCalledWith(queue);
    expect(setPlaybackQueue).toHaveBeenCalledTimes(1);
    const restored = setCurrentTrack.mock.calls[0]?.[0] as Track;
    expect(restored.id).toBe("t1");
    expect(restored.restoreTime).toBe(7);
    expect(setPlayMode).toHaveBeenCalledWith("normal");
    expect(triggerReload).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });
});

describe("usePlayerSession restore lifecycle (SC1 — no commit after teardown)", () => {
  it("S: PLAYER_STOP_EVENT (logout) trong lúc restore await → bỏ toàn bộ commit + không arm resume hint", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGet.mockResolvedValue(undefined);
    let resolveToken: (token: string) => void = () => {};
    mockedGetValidToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );

    const {
      setCurrentTrack,
      setOriginalQueue,
      setPlaybackQueue,
      setPlayMode,
      triggerReload,
    } = makeHook();
    await flushMicrotasks();
    expect(mockedGetValidToken).toHaveBeenCalledTimes(1);

    // Teardown (logout) fires while the restore is still awaiting its token:
    // the controller must be invalidated, not merely out-guarded by the store
    // (teardown clears the store, so the emptiness guard is moot).
    act(() => {
      window.dispatchEvent(new Event(PLAYER_STOP_EVENT));
    });

    resolveToken("test-token");
    await flushMicrotasks();

    expect(setCurrentTrack).not.toHaveBeenCalled();
    expect(setOriginalQueue).not.toHaveBeenCalled();
    expect(setPlaybackQueue).not.toHaveBeenCalled();
    expect(setPlayMode).not.toHaveBeenCalled();
    expect(triggerReload).not.toHaveBeenCalled();
    expect(consumeRestoreResume("t1")).toBeUndefined();
  });

  it("T: stop chỉ vô hiệu restore đang bay — mount kế tiếp (login lại) vẫn restore bình thường", async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ track: makeTrack("t1", "q1"), time: 5, duration: 100 }),
    );
    mockedGet.mockResolvedValue(undefined);
    let resolveToken: (token: string) => void = () => {};
    mockedGetValidToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );

    makeHook();
    await flushMicrotasks();
    act(() => {
      window.dispatchEvent(new Event(PLAYER_STOP_EVENT));
    });
    resolveToken("test-token");
    await flushMicrotasks();

    // Session mới (login lại) mount controller mới: abort của session cũ
    // không được rò sang.
    const { setCurrentTrack, triggerReload } = makeHook();
    await flushMicrotasks();

    expect(setCurrentTrack).toHaveBeenCalledTimes(1);
    expect(triggerReload).toHaveBeenCalledTimes(1);
  });
});

describe("usePlayerSession save identity (R2.1 — no {track B, time A} pairs)", () => {
  function savedSession(): { track?: Track; time?: number } | null {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { track?: Track; time?: number }) : null;
  }

  function saveHandlers() {
    return {
      time: audioMock.on.mock.calls.find((c) => c[0] === "timeupdate")?.[1] as
        ((payload?: unknown) => void) | undefined,
      pause: audioMock.on.mock.calls.find((c) => c[0] === "pause")?.[1] as
        ((payload?: unknown) => void) | undefined,
      ended: audioMock.on.mock.calls.find((c) => c[0] === "ended")?.[1] as
        ((payload?: unknown) => void) | undefined,
    };
  }

  beforeEach(() => {
    // Deterministic throttle clock: the event-driven save is time-gated at 5s
    // and performance.now() is wall-clock in jsdom (may still be < 5s here).
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.mocked(usePlayerStore.getState).mockReturnValue({
      currentTrack: makeTrack("t1", "q1"),
    } as unknown as ReturnType<typeof usePlayerStore.getState>);
    vi.mocked(audioMock.getCurrentTime).mockReturnValue(10);
    vi.mocked(audioMock.getDuration).mockReturnValue(240);
  });

  it("timeupdate of another track (engine still on A) skips the save — no {t1, timeA}", () => {
    makeHook();
    const { time } = saveHandlers();

    act(() => {
      time?.({ trackId: "t2", attempt: 9 });
    });
    expect(savedSession()).toBeNull();

    act(() => {
      time?.({ trackId: "t1", attempt: 1 });
    });
    expect(savedSession()).toMatchObject({ time: 10 });
    expect(savedSession()?.track?.id).toBe("t1");
  });

  it("pause of another track skips the forced save; its own pause saves", () => {
    makeHook();
    const { pause } = saveHandlers();

    act(() => {
      pause?.({ trackId: "t2", attempt: 9 });
    });
    expect(savedSession()).toBeNull();

    act(() => {
      pause?.({ trackId: "t1", attempt: 1 });
    });
    expect(savedSession()).toMatchObject({ time: 10 });
  });

  it("ended of another track skips the forced save; its own ended saves the final position", () => {
    makeHook();
    const { ended } = saveHandlers();

    act(() => {
      ended?.({ trackId: "t2", attempt: 9 });
    });
    expect(savedSession()).toBeNull();

    act(() => {
      ended?.({ trackId: "t1", attempt: 1 });
    });
    expect(savedSession()).toMatchObject({ time: 10 });
  });

  it("untagged events (older sender) keep legacy behavior", () => {
    makeHook();
    const { time } = saveHandlers();

    act(() => {
      time?.();
    });
    expect(savedSession()).toMatchObject({ time: 10 });
  });
});

describe("usePlayerSession save identity (SC6 — store/engine pair)", () => {
  function savedSession(): { track?: Track; time?: number } | null {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { track?: Track; time?: number }) : null;
  }

  function pauseHandler() {
    return audioMock.on.mock.calls.find((c) => c[0] === "pause")?.[1] as
      ((payload?: unknown) => void) | undefined;
  }

  beforeEach(() => {
    vi.mocked(usePlayerStore.getState).mockReturnValue({
      currentTrack: makeTrack("t1", "q1"),
    } as unknown as ReturnType<typeof usePlayerStore.getState>);
    vi.mocked(audioMock.getCurrentTime).mockReturnValue(30);
    vi.mocked(audioMock.getDuration).mockReturnValue(240);
  });

  it("U: engine còn ở track cũ (untagged event) → skip save, không ghi {t1, time_A}; khi engine sang t1 thì save lại bình thường", () => {
    vi.mocked(audioMock.getCurrentTrackId).mockReturnValue("t0");

    makeHook();
    act(() => {
      // Untagged: passes the R2.1 event filter, so this pins the SAVE-layer
      // guard independently of the subscription filter.
      pauseHandler()?.();
    });
    expect(savedSession()).toBeNull();

    vi.mocked(audioMock.getCurrentTrackId).mockReturnValue("t1");
    act(() => {
      pauseHandler()?.();
    });
    expect(savedSession()).toMatchObject({ time: 30 });
    expect(savedSession()?.track?.id).toBe("t1");
  });

  it("V: engine khớp store → save ghi đúng cặp {t1, time}", () => {
    vi.mocked(audioMock.getCurrentTrackId).mockReturnValue("t1");

    makeHook();
    act(() => {
      pauseHandler()?.();
    });

    expect(savedSession()).toMatchObject({ time: 30 });
    expect(savedSession()?.track?.id).toBe("t1");
  });
});
