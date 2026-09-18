// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayer, PLAYER_STOP_EVENT } from "./usePlayer";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";
import { showErrorToast } from "../utils/simpleToast";
import { metadataCache, getTrackMetadata } from "../utils/metadata";
import type { CachedMetadata } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
}));

vi.mock("tauri-plugin-keepawake-api", () => ({
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/history", () => ({
  recordPlay: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/metadata", () => ({
  getTrackMetadata: vi.fn(() => Promise.resolve({ duration: 200 })),
  metadataCache: new Map(),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(() => Promise.resolve("test-token")),
}));

vi.mock("../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(() => undefined),
  DRIVE_STREAM_PREFIX: "/drive-stream/",
  buildStreamUrl: vi.fn((id: string) => `/drive-stream/${id}`),
}));

vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("../utils/sessionCleanup", () => ({
  SESSION_CLEANUP_KEYS: {
    playModeKv: "drplay_playmode",
    queueKv: "drplay_queue",
    lastSessionLocalStorage: "drplay_last_session",
    lastSessionKv: "drplay_last_session_kv",
  },
}));

const queueMock = vi.hoisted(() => ({
  handleNextTrack: vi.fn(),
  handlePrevTrack: vi.fn(),
  handleTogglePlayMode: vi.fn(),
  handleSetPlayMode: vi.fn(),
  updateQueueContext: vi.fn((track: Track) => track),
}));

vi.mock("./player/usePlayerQueue", () => ({
  usePlayerQueue: () => queueMock,
}));

vi.mock("./player/usePlayerSession", () => ({
  usePlayerSession: vi.fn(),
}));

const audioMock = vi.hoisted(() => ({
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 0),
  seek: vi.fn(),
  pause: vi.fn(),
  togglePlay: vi.fn(),
  on: vi.fn(() => vi.fn()),
  release: vi.fn(),
}));

vi.mock("../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

const mediaControlsMock = vi.hoisted(() => ({
  options: null as {
    onTogglePlay: () => void;
    onNext: () => void;
    onPrev: () => void;
  } | null,
}));

vi.mock("./useMediaControls", () => ({
  useMediaControls: (options: {
    onTogglePlay: () => void;
    onNext: () => void;
    onPrev: () => void;
  }) => {
    mediaControlsMock.options = options;
  },
}));

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    streamUrl: `https://stream.example/${id}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePlayerStore.setState({
    currentTrack: null,
    loadNonce: 0,
    isPlaying: false,
    isDownloading: false,
    playMode: "normal",
    originalQueue: [],
    playbackQueue: [],
  });
  audioMock.getCurrentTime.mockReturnValue(0);
  audioMock.getDuration.mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePlayer media controls integration", () => {
  it("mount → useMediaControls nhận handler nối đúng queue (next/prev)", () => {
    renderHook(() => usePlayer("test-token"));

    expect(mediaControlsMock.options).not.toBeNull();

    act(() => {
      mediaControlsMock.options?.onNext();
    });
    expect(queueMock.handleNextTrack).toHaveBeenCalledTimes(1);

    act(() => {
      mediaControlsMock.options?.onPrev();
    });
    expect(queueMock.handlePrevTrack).toHaveBeenCalledTimes(1);
  });

  it("onTogglePlay khi paused (track có streamUrl) → resume qua handleTogglePlay → store isPlaying true", () => {
    usePlayerStore.setState({
      currentTrack: makeTrack("t1"),
      isPlaying: false,
    });
    renderHook(() => usePlayer("test-token"));

    act(() => {
      mediaControlsMock.options?.onTogglePlay();
    });
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("unmount usePlayer không throw (hook native vắng mặt trong jsdom)", () => {
    const { unmount } = renderHook(() => usePlayer("test-token"));
    unmount();
  });

  it("return shape: expose đủ API player cho UI (smoke)", () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    expect(typeof result.current.handlePlayTrack).toBe("function");
    expect(typeof result.current.handleNextTrack).toBe("function");
    expect(typeof result.current.handlePrevTrack).toBe("function");
    expect(typeof result.current.handleTogglePlay).toBe("function");
    expect(typeof result.current.handleTogglePlayMode).toBe("function");
    expect(typeof result.current.handleSetPlayMode).toBe("function");
    expect(typeof result.current.setIsPlaying).toBe("function");
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTrack).toBeNull();
  });
});

describe("usePlayer broken-track reset on logout (Task D residual)", () => {
  it("PLAYER_STOP_EVENT → brokenTrackIds reset về [] (không sót sang session sau)", () => {
    renderHook(() => usePlayer("test-token"));

    act(() => {
      usePlayerStore.getState().markTrackBroken("broken-1");
      usePlayerStore.getState().markTrackBroken("broken-2");
    });
    expect(usePlayerStore.getState().brokenTrackIds).toEqual([
      "broken-1",
      "broken-2",
    ]);

    act(() => {
      window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));
    });
    expect(usePlayerStore.getState().brokenTrackIds).toEqual([]);
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(usePlayerStore.getState().originalQueue).toEqual([]);
    expect(usePlayerStore.getState().playbackQueue).toEqual([]);
  });
});

describe("usePlayer next-track prefetch", () => {
  it("play một track trong queue → KHÔNG phát request mạng nào cho track kế (sw.js no-store làm warm-cache prefetch vô nghĩa — đã bỏ)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(makeTrack("t1"), [
        makeTrack("t1"),
        makeTrack("t2"),
      ]);
    });

    const urls = fetchSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((u) => u.includes("/drive-stream/t2"));
    expect(urls).toHaveLength(0);
  });
});

describe("usePlayer pre-play streamUnplayable gate (P1)", () => {
  const gateTrack = (id: string): Track => ({ ...makeTrack(id), size: 2048 });

  const makeFlagged = (unplayable: boolean | undefined): CachedMetadata => ({
    title: "t",
    artist: "a",
    duration: 200,
    durationEstimated: false,
    pictureData: null,
    pictureDataFull: null,
    v: 8,
    ...(unplayable !== undefined ? { streamUnplayable: unplayable } : {}),
  });

  beforeEach(() => {
    metadataCache.clear();
  });

  it("click lần 1 trên track cờ → bị chặn: không session, không isPlaying, có toast", async () => {
    metadataCache.set("gate-a", makeFlagged(true));
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(gateTrack("gate-a"), [
        gateTrack("gate-a"),
      ]);
    });

    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(vi.mocked(showErrorToast)).toHaveBeenCalledTimes(1);
  });

  it("click lần 2 ĐÚNG track vừa bị chặn → force phát bình thường (toast không lặp)", async () => {
    metadataCache.set("gate-b", makeFlagged(true));
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(gateTrack("gate-b"), [
        gateTrack("gate-b"),
      ]);
    });
    await act(async () => {
      await result.current.handlePlayTrack(gateTrack("gate-b"), [
        gateTrack("gate-b"),
      ]);
    });

    expect(usePlayerStore.getState().currentTrack?.id).toBe("gate-b");
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(vi.mocked(showErrorToast)).toHaveBeenCalledTimes(1);
  });

  it("phát track khác giữa chừng → ref reset, quay lại track cờ bị chặn lại từ đầu", async () => {
    metadataCache.set("gate-c", makeFlagged(true));
    metadataCache.set("gate-d", makeFlagged(undefined));
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(gateTrack("gate-c"), [
        gateTrack("gate-c"),
      ]);
    });
    await act(async () => {
      await result.current.handlePlayTrack(gateTrack("gate-d"), [
        gateTrack("gate-d"),
      ]);
    });
    await act(async () => {
      await result.current.handlePlayTrack(gateTrack("gate-c"), [
        gateTrack("gate-c"),
      ]);
    });

    expect(usePlayerStore.getState().currentTrack?.id).toBe("gate-d");
    expect(vi.mocked(showErrorToast)).toHaveBeenCalledTimes(2);
  });

  it("track không cờ → phát như cũ, không toast", async () => {
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(gateTrack("gate-e"), [
        gateTrack("gate-e"),
      ]);
    });

    expect(usePlayerStore.getState().currentTrack?.id).toBe("gate-e");
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(vi.mocked(showErrorToast)).not.toHaveBeenCalled();
  });

  it("isNavigation=true (auto-advance) bỏ qua gate → track cờ vẫn được phát thử", async () => {
    metadataCache.set("gate-f", makeFlagged(true));
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handlePlayTrack(
        gateTrack("gate-f"),
        undefined,
        true,
      );
    });

    expect(usePlayerStore.getState().currentTrack?.id).toBe("gate-f");
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(vi.mocked(showErrorToast)).not.toHaveBeenCalled();
  });
});

describe("usePlayer resume path — no streamUrl, paused (B14-1/B14-2)", () => {
  const resumeTrack = (id: string): Track => ({
    ...makeTrack(id),
    streamUrl: "",
  });

  it("B14-2: token resolve → commit NGAY (URL + triggerReload + isPlaying), không chờ metadata", async () => {
    vi.mocked(getTrackMetadata).mockReturnValueOnce(
      new Promise<never>(() => {}),
    );
    usePlayerStore.setState({
      currentTrack: resumeTrack("resume-1"),
      isPlaying: false,
    });
    const { result } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      void result.current.handleTogglePlay();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.streamUrl).toBe("/drive-stream/resume-1");
    expect(state.isPlaying).toBe(true);
    expect(state.loadNonce).toBe(1);
  });

  it("B14-1: abort giữa token (STOP) → KHÔNG commit URL/triggerReload/isPlaying", async () => {
    let resolveToken: ((token: string) => void) | undefined;
    vi.mocked(getValidToken).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveToken = resolve;
      }),
    );
    usePlayerStore.setState({
      currentTrack: resumeTrack("resume-2"),
      isPlaying: false,
    });
    const { result } = renderHook(() => usePlayer("test-token"));

    act(() => {
      void result.current.handleTogglePlay();
    });

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));
      resolveToken?.("fresh-token");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = usePlayerStore.getState();
    expect(state.currentTrack).toBeNull();
    expect(state.isPlaying).toBe(false);
    expect(state.loadNonce).toBe(0);
  });
});

describe("usePlayer resume intent ownership (R5b/RC-6) — user pause aborts in-flight resume", () => {
  const resumeTrack = (id: string): Track => ({
    ...makeTrack(id),
    streamUrl: "",
  });

  it("R6-1: user pause trong lúc resume await → attempt bị abort, KHÔNG commit, isPlaying giữ false, spinner clear", async () => {
    let resolveToken: ((token: string) => void) | undefined;
    vi.mocked(getValidToken).mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveToken = resolve;
      }),
    );
    usePlayerStore.setState({
      currentTrack: resumeTrack("r6-1"),
      isPlaying: false,
    });
    const { result, unmount } = renderHook(() => usePlayer("test-token"));

    act(() => {
      void result.current.handleTogglePlay();
    });
    expect(usePlayerStore.getState().isDownloading).toBe(true);

    // Engine/đường khác đẩy isPlaying=true trong lúc token còn pending → lần
    // toggle kế tiếp rơi vào else-branch và là một lệnh PAUSE của user.
    act(() => {
      usePlayerStore.setState({ isPlaying: true });
    });
    act(() => {
      void result.current.handleTogglePlay();
    });
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    await act(async () => {
      resolveToken?.("fresh-token");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.currentTrack?.streamUrl).toBe("");
    expect(state.loadNonce).toBe(0);
    expect(state.isDownloading).toBe(false);
    unmount();
  });

  it("R6-2: resume hoàn tất bình thường → commit URL + isPlaying true, spinner clear", async () => {
    usePlayerStore.setState({
      currentTrack: resumeTrack("r6-2"),
      isPlaying: false,
    });
    const { result, unmount } = renderHook(() => usePlayer("test-token"));

    await act(async () => {
      await result.current.handleTogglePlay();
    });

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.streamUrl).toBe("/drive-stream/r6-2");
    expect(state.isPlaying).toBe(true);
    expect(state.loadNonce).toBe(1);
    expect(state.isDownloading).toBe(false);
    unmount();
  });

  it("R6-3: resume bị supersede → attempt cũ resolve muộn KHÔNG clear isDownloading của attempt mới", async () => {
    let resolveA: ((token: string) => void) | undefined;
    let resolveB: ((token: string) => void) | undefined;
    vi.mocked(getValidToken)
      .mockReturnValueOnce(
        new Promise<string>((resolve) => {
          resolveA = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<string>((resolve) => {
          resolveB = resolve;
        }),
      );
    usePlayerStore.setState({
      currentTrack: resumeTrack("r6-3"),
      isPlaying: false,
    });
    const { result, unmount } = renderHook(() => usePlayer("test-token"));

    act(() => {
      void result.current.handleTogglePlay();
    });
    act(() => {
      void result.current.handleTogglePlay();
    });
    expect(usePlayerStore.getState().isDownloading).toBe(true);

    await act(async () => {
      resolveA?.("token-a");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // A đã bị abort bởi attempt B → không commit, không clear spinner của B.
    expect(usePlayerStore.getState().isDownloading).toBe(true);
    expect(usePlayerStore.getState().currentTrack?.streamUrl).toBe("");
    expect(usePlayerStore.getState().loadNonce).toBe(0);

    await act(async () => {
      resolveB?.("token-b");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(usePlayerStore.getState().currentTrack?.streamUrl).toBe(
      "/drive-stream/r6-3",
    );
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(usePlayerStore.getState().isDownloading).toBe(false);
    unmount();
  });
});
