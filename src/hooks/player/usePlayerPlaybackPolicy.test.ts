// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { usePlayerPlaybackPolicy } from "./usePlayerPlaybackPolicy";
import { usePlayerStore } from "../../store/playerStore";
import {
  guardAllowsAutoAdvance,
  resetAdvanceGuard,
} from "../../utils/playerError";
import { __resetPlaybackIntentForTests, beginIntent } from "./playbackIntent";

// R2.3: these are the policy tests MOVED out of PlayerBar.test.tsx —
// mark-broken, storm guard, repeat-one replay, errorInfo writes, storm banner
// cooldown and R2.1 identity filtering. They now exercise the hook directly
// (no UI render needed); PlayerBar's suite keeps only render/display/bridge/
// manual-callback tests.
const { fakeController } = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  const fakeController = {
    on: vi.fn(),
    playTrack: vi.fn(),
    _handlers: {} as Record<string, Handler[]>,
    _emit(event: string, payload?: unknown) {
      for (const h of fakeController._handlers[event] ?? []) h(payload);
    },
  };
  return { fakeController };
});

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => fakeController },
}));

function installFakeOn() {
  fakeController.on.mockImplementation(
    (event: string, handler: (payload: unknown) => void) => {
      (fakeController._handlers[event] ??= []).push(handler);
      return () => {
        fakeController._handlers[event] = (
          fakeController._handlers[event] ?? []
        ).filter((h) => h !== handler);
      };
    },
  );
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "Song",
    artist: "Artist",
    streamUrl: "/drive-stream/track-1",
    ...overrides,
  };
}

function renderPolicy(onNextTrack = vi.fn()) {
  const view = renderHook(() => {
    usePlayerPlaybackPolicy({ onNextTrack });
  });
  return { ...view, onNextTrack };
}

const FORMAT_ERROR = {
  message: "File lỗi định dạng, đang bỏ qua...",
  code: "format_error",
};
const NETWORK_ERROR = {
  message: "Mạng không ổn định, đang thử lại...",
  code: "network_interrupted",
};

beforeEach(() => {
  fakeController.on.mockClear();
  fakeController.playTrack.mockClear();
  installFakeOn();
  fakeController._handlers = {};
  __resetPlaybackIntentForTests();
  usePlayerStore.setState({
    currentTrack: makeTrack(),
    isPlaying: true,
    playMode: "normal",
    brokenTrackIds: [],
    errorInfo: null,
  });
  resetAdvanceGuard();
});

afterEach(() => {
  // The project has no vitest `globals`, so RTL auto-cleanup is not
  // registered: without this, every hook instance of the file stays mounted
  // and keeps subscribing/arming storm timers across tests.
  cleanup();
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    playMode: "normal",
    brokenTrackIds: [],
    errorInfo: null,
  });
  resetAdvanceGuard();
  vi.useRealTimers();
});

describe("usePlayerPlaybackPolicy error surface", () => {
  it("BUG regression: error event publishes the shared error surface to the store", () => {
    renderPolicy();
    expect(usePlayerStore.getState().errorInfo).toBeNull();

    act(() => {
      fakeController._emit("error", NETWORK_ERROR);
    });

    expect(usePlayerStore.getState().errorInfo).toEqual(NETWORK_ERROR);
  });

  it("BUG regression: play event clears the error banner (recovery)", () => {
    renderPolicy();
    act(() => {
      fakeController._emit("error", NETWORK_ERROR);
    });
    expect(usePlayerStore.getState().errorInfo).toEqual(NETWORK_ERROR);

    act(() => {
      fakeController._emit("play");
    });

    expect(usePlayerStore.getState().errorInfo).toBeNull();
  });

  it("unsubscribes the policy handlers on unmount (no listener leak)", () => {
    const { unmount } = renderPolicy();
    expect(fakeController._handlers["error"] ?? []).toHaveLength(1);
    expect(fakeController._handlers["ended"] ?? []).toHaveLength(1);
    expect(fakeController._handlers["play"] ?? []).toHaveLength(1);
    expect(fakeController._handlers["pause"] ?? []).toHaveLength(1);

    unmount();

    expect(fakeController._handlers["error"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["ended"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["play"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["pause"] ?? []).toHaveLength(0);
  });
});

// R3.2: the engine stopped writing the store — every engine→store transition
// is projected here from the emitted fact. These tests lock the projection
// (value + identity filter), the engine suites lock the fact emission.
describe("usePlayerPlaybackPolicy engine-fact projection (R3.2)", () => {
  const CURRENT = { trackId: "track-1", attempt: 7 };

  it("pause fact of the current track → isPlaying=false", () => {
    renderPolicy();
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    act(() => {
      fakeController._emit("pause", CURRENT);
    });

    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("play fact of the current track → isPlaying=true", () => {
    renderPolicy();
    usePlayerStore.setState({ isPlaying: false });

    act(() => {
      fakeController._emit("play", CURRENT);
    });

    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("network_interrupted error (terminal playbackFailure) → isPlaying=false", () => {
    renderPolicy();

    act(() => {
      fakeController._emit("error", { ...NETWORK_ERROR, ...CURRENT });
    });

    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("format_error error does NOT flip isPlaying — the ended/advance policy owns that state (repeat-one parity)", () => {
    renderPolicy();

    act(() => {
      fakeController._emit("error", { ...FORMAT_ERROR, ...CURRENT });
    });

    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("foreign track facts never mutate the store (R2.1): pause/play/error", () => {
    const foreign = { trackId: "stale-track", attempt: 1 };
    renderPolicy();

    act(() => {
      fakeController._emit("pause", foreign);
    });
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    act(() => {
      fakeController._emit("error", { ...NETWORK_ERROR, ...foreign });
    });
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    usePlayerStore.setState({ isPlaying: false });
    act(() => {
      fakeController._emit("play", foreign);
    });
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });
});

describe("usePlayerPlaybackPolicy broken-track marking (Task D — repeat-all loop guard)", () => {
  it("Task D regression: error format_error → đánh dấu track hiện tại broken (auto-advance sẽ skip)", () => {
    renderPolicy();
    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });

    expect(usePlayerStore.getState().brokenTrackIds).toContain("track-1");
  });

  it("Task D: error network_interrupted (retryable) → KHÔNG đánh dấu broken", () => {
    renderPolicy();

    act(() => {
      fakeController._emit("error", NETWORK_ERROR);
    });

    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");
  });

  it("Task D: ended tự nhiên (không kèm error) → KHÔNG đánh dấu broken (auto-advance như cũ)", () => {
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("ended");
    });

    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");
    expect(onNextTrack).toHaveBeenCalledTimes(1);
  });

  it("Task D: không có currentTrack → error format_error không crash, không đánh dấu", () => {
    usePlayerStore.setState({ currentTrack: null });
    renderPolicy();

    expect(() => {
      act(() => {
        fakeController._emit("error", FORMAT_ERROR);
      });
    }).not.toThrow();
    expect(usePlayerStore.getState().brokenTrackIds).toEqual([]);
  });
});

describe("usePlayerPlaybackPolicy auto-advance storm guard (Fix I — queue cháy hết im lặng)", () => {
  function stormBlock(onNext: ReturnType<typeof vi.fn>) {
    // 3 lần error format_error + ended liên tiếp → chạm ngưỡng storm
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(2);
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    expect(usePlayerStore.getState().errorInfo?.code).toBe("advance_stopped");
    act(() => {
      fakeController._emit("ended");
    });
  }

  it("Fix I regression: 3 format_error liên tiếp trong window → ended thứ 3 KHÔNG next, dừng phát + hiện thông báo storm", () => {
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNextTrack).toHaveBeenCalledTimes(2);

    // Lỗi thứ 3 chạm ngưỡng STORM_ERRORS → thông báo rõ ràng thay vì toast
    // format_error bị reset theo track (root cause: user không thấy gì).
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    expect(usePlayerStore.getState().errorInfo?.code).toBe("advance_stopped");

    // Ended kèm theo KHÔNG được auto-next — queue dừng đốt, playback dừng.
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNextTrack).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("Fix I: 2 lỗi rồi window trôi (15s) → lỗi sau mở cửa sổ mới, ended vẫn next (không chặn nhầm)", () => {
    vi.useFakeTimers();
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    // Window 15s đã trôi hẳn so với lỗi đầu → lỗi tiếp theo bắt đầu cửa sổ mới
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });

    expect(onNextTrack).toHaveBeenCalledTimes(1);
    // Not the storm banner — the 3rd error is a fresh window (per-track toast).
    expect(usePlayerStore.getState().errorInfo?.code).not.toBe(
      "advance_stopped",
    );
  });

  it("Fix I: 'play' event (phát thành công) reset counter → 2 lỗi kế tiếp vẫn next, lỗi thứ 3 kể từ reset mới chặn", () => {
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNextTrack).toHaveBeenCalledTimes(2);

    // Phát thành công → guard reset (nếu không reset, lỗi kế tiếp đã chặn)
    act(() => {
      fakeController._emit("play");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNextTrack).toHaveBeenCalledTimes(4);

    // Lỗi thứ 3 kể từ play → chặn như storm mới
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    expect(usePlayerStore.getState().errorInfo?.code).toBe("advance_stopped");
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNextTrack).toHaveBeenCalledTimes(4);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("Fix I: network_interrupted (retryable) KHÔNG đếm vào storm counter", () => {
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("error", NETWORK_ERROR);
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });

    // Vẫn chặn sau đúng 3 format_error (network không cộng dồn)
    expect(onNextTrack).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().errorInfo?.code).toBe("advance_stopped");
  });

  it("Fix I: ended phát hết bài tự nhiên (không có format_error trước) → luôn next, không bao giờ chặn", () => {
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("ended");
    });

    expect(onNextTrack).toHaveBeenCalledTimes(3);
    expect(usePlayerStore.getState().errorInfo).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("F8-3: hết cooldown 30s không có error mới → banner advance_stopped tự clear + guard re-arm", () => {
    vi.useFakeTimers();
    const { onNextTrack } = renderPolicy();

    stormBlock(onNextTrack);
    expect(usePlayerStore.getState().errorInfo?.code).toBe("advance_stopped");
    expect(guardAllowsAutoAdvance(Date.now())).toBe(false);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(usePlayerStore.getState().errorInfo).toBeNull();
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);
  });

  it("F8-3: error khác overwrite banner storm → hết cooldown KHÔNG clear lỗi khác", () => {
    vi.useFakeTimers();
    const { onNextTrack } = renderPolicy();

    stormBlock(onNextTrack);
    act(() => {
      fakeController._emit("error", NETWORK_ERROR);
    });
    expect(usePlayerStore.getState().errorInfo).toEqual(NETWORK_ERROR);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(usePlayerStore.getState().errorInfo).toEqual(NETWORK_ERROR);
  });

  it("F8-3: unmount → timer storm được cleanup (không tự clear store sau khi hook gỡ)", () => {
    vi.useFakeTimers();
    const { onNextTrack, unmount } = renderPolicy();

    stormBlock(onNextTrack);
    expect(usePlayerStore.getState().errorInfo?.code).toBe("advance_stopped");

    unmount();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(usePlayerStore.getState().errorInfo?.code).toBe("advance_stopped");
  });
});

describe("usePlayerPlaybackPolicy repeat-one ended replay (B16-3)", () => {
  it("B16-3: ended + repeat-one → replay cùng track từ 0, KHÔNG next", () => {
    const cur = makeTrack();
    usePlayerStore.setState({ currentTrack: cur, playMode: "repeat-one" });
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("ended");
    });

    expect(fakeController.playTrack).toHaveBeenCalledTimes(1);
    expect(fakeController.playTrack).toHaveBeenCalledWith(cur, 0);
    expect(onNextTrack).not.toHaveBeenCalled();
  });

  it("B16-3 regression: ended + mode thường → next, không replay", () => {
    const cur = makeTrack();
    usePlayerStore.setState({ currentTrack: cur, playMode: "normal" });
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("ended");
    });

    expect(onNextTrack).toHaveBeenCalledTimes(1);
    expect(fakeController.playTrack).not.toHaveBeenCalled();
  });
});

describe("usePlayerPlaybackPolicy event identity filtering (R2.1 — stale-track misattribution)", () => {
  // Window under test: the store already points at the new track (B,
  // "track-1") while the engine is still finishing the old one (A,
  // "stale-track"). A's terminal events must not mutate B's state.
  const stalePayload = { trackId: "stale-track", attempt: 1 };

  it("error of another track: no broken mark, no banner for the current track", () => {
    renderPolicy();

    act(() => {
      fakeController._emit("error", { ...FORMAT_ERROR, ...stalePayload });
    });

    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");
    expect(usePlayerStore.getState().errorInfo).toBeNull();
  });

  it("ended of another track: never auto-advances the current track", () => {
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("ended", stalePayload);
    });

    expect(onNextTrack).not.toHaveBeenCalled();
  });

  it("ended of another track: no repeat-one replay of the current track", () => {
    usePlayerStore.setState({ playMode: "repeat-one" });
    renderPolicy();

    act(() => {
      fakeController._emit("ended", stalePayload);
    });

    expect(fakeController.playTrack).not.toHaveBeenCalled();
  });

  it("play of another track: keeps the current track's error banner", () => {
    usePlayerStore.setState({
      errorInfo: { code: "network_interrupted", message: "boom" },
    });
    renderPolicy();

    act(() => {
      fakeController._emit("play", stalePayload);
    });

    expect(usePlayerStore.getState().errorInfo).toEqual({
      code: "network_interrupted",
      message: "boom",
    });
  });

  it("error of the current track: still marks it broken + shows the banner", () => {
    renderPolicy();

    act(() => {
      fakeController._emit("error", {
        ...FORMAT_ERROR,
        trackId: "track-1",
        attempt: 7,
      });
    });

    expect(usePlayerStore.getState().brokenTrackIds).toContain("track-1");
    expect(usePlayerStore.getState().errorInfo).toEqual({
      code: "format_error",
      message: "File lỗi định dạng, đang bỏ qua...",
    });
  });

  it("ended of the current track: still auto-advances", () => {
    const { onNextTrack } = renderPolicy();

    act(() => {
      fakeController._emit("ended", { trackId: "track-1", attempt: 7 });
    });

    expect(onNextTrack).toHaveBeenCalledTimes(1);
  });
});

describe("usePlayerPlaybackPolicy auto-advance system guard (R3.1a — contract (a))", () => {
  it("ended while a user intent is in flight → auto-advance is blocked (user wins, no next)", () => {
    const { onNextTrack } = renderPolicy();
    const user = beginIntent("play");

    act(() => {
      fakeController._emit("ended");
    });

    expect(onNextTrack).not.toHaveBeenCalled();
    expect(user.isCurrent()).toBe(true);
    expect(user.abortSignal.aborted).toBe(false);

    user.end();
  });
});
