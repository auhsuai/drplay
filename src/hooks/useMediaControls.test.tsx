// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useMediaControls,
  type UseMediaControlsOptions,
} from "./useMediaControls";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";

type PayloadLike = { action: string; position?: number | null };

const bridgeMock = vi.hoisted(() => ({
  emit: null as ((payload: PayloadLike) => void) | null,
  unlisten: vi.fn(),
  update: vi.fn<(snapshot: Record<string, unknown>) => void>(() => {}),
  listen: vi.fn(),
}));

vi.mock("../lib/mediaControls", () => ({
  listenMediaControls: (handler: (payload: PayloadLike) => void) => {
    bridgeMock.emit = handler;
    bridgeMock.listen(handler);
    return Promise.resolve(bridgeMock.unlisten);
  },
  updateMediaControls: (snapshot: Record<string, unknown>) => {
    bridgeMock.update(snapshot);
    return Promise.resolve();
  },
}));

const audioMock = vi.hoisted(() => {
  const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
  return {
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    seek: vi.fn(),
    pause: vi.fn(),
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
      return () => {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      };
    }),
    _emit(event: string, payload?: unknown) {
      for (const h of handlers[event] ?? []) h(payload);
    },
  };
});

vi.mock("../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    streamUrl: `https://stream.example/${id}`,
  };
}

async function mount(options?: Partial<UseMediaControlsOptions>) {
  const onTogglePlay = vi.fn();
  const onNext = vi.fn();
  const onPrev = vi.fn();
  const view = renderHook((props?: Partial<UseMediaControlsOptions>) => {
    useMediaControls({
      onTogglePlay,
      onNext,
      onPrev,
      ...options,
      ...props,
    });
  });
  // listenMediaControls resolves on a microtask; flush it so the OS ->
  // app listener is wired before a test emits.
  await act(async () => {});
  return { ...view, onTogglePlay, onNext, onPrev };
}

function emit(payload: PayloadLike) {
  if (!bridgeMock.emit) throw new Error("media-control listener not wired");
  act(() => {
    bridgeMock.emit?.(payload);
  });
}

function lastSnapshot(): Record<string, unknown> {
  const calls = bridgeMock.update.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error("no snapshot pushed");
  return last[0];
}

function revisions(): number[] {
  return bridgeMock.update.mock.calls.map(
    (call) => (call[0] as { revision: number }).revision,
  );
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
  // vitest runs without globals, so Testing Library cannot self-register its
  // auto-cleanup: leaked mounted hooks would keep pushing snapshots into the
  // next test's mock.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useMediaControls OS -> app actions", () => {
  it("play: đang paused → onTogglePlay; đang playing → bỏ qua", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack("t1"),
      isPlaying: false,
    });
    const { onTogglePlay } = await mount();

    emit({ action: "play" });
    expect(onTogglePlay).toHaveBeenCalledTimes(1);

    act(() => {
      usePlayerStore.setState({ isPlaying: true });
    });
    emit({ action: "play" });
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("pause: đang playing → audio.pause(); đang paused → bỏ qua", async () => {
    usePlayerStore.setState({ currentTrack: makeTrack("t1"), isPlaying: true });
    await mount();

    emit({ action: "pause" });
    expect(audioMock.pause).toHaveBeenCalledTimes(1);

    act(() => {
      usePlayerStore.setState({ isPlaying: false });
    });
    emit({ action: "pause" });
    expect(audioMock.pause).toHaveBeenCalledTimes(1);
  });

  it("toggle → onTogglePlay bất kể trạng thái", async () => {
    const { onTogglePlay } = await mount();

    emit({ action: "toggle" });
    emit({ action: "toggle" });
    expect(onTogglePlay).toHaveBeenCalledTimes(2);
  });

  it("next/previous → chuyển bài qua handler queue sẵn có", async () => {
    const { onNext, onPrev } = await mount();

    emit({ action: "next" });
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();

    emit({ action: "previous" });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("stop → pause (không có stop riêng trong player)", async () => {
    await mount();
    emit({ action: "stop" });
    expect(audioMock.pause).toHaveBeenCalledTimes(1);
  });

  it("seek: position hợp lệ → audio.seek; thiếu/không hợp lệ → no-op", async () => {
    await mount();

    emit({ action: "seek", position: 120 });
    expect(audioMock.seek).toHaveBeenLastCalledWith(120);

    emit({ action: "seek" });
    emit({ action: "seek", position: Number.NaN });
    expect(audioMock.seek).toHaveBeenCalledTimes(1);
  });

  it("seek-forward/seek-backward dùng seekRelative (clamp theo duration)", async () => {
    audioMock.getCurrentTime.mockReturnValue(30);
    audioMock.getDuration.mockReturnValue(120);
    await mount();

    emit({ action: "seek-forward" });
    expect(audioMock.seek).toHaveBeenLastCalledWith(35);

    emit({ action: "seek-backward" });
    expect(audioMock.seek).toHaveBeenLastCalledWith(25);
  });

  it("callback luôn là bản mới nhất sau rerender (ref sync)", async () => {
    const { rerender, onNext } = await mount();
    const onNextV2 = vi.fn();

    rerender({ onTogglePlay: vi.fn(), onNext: onNextV2, onPrev: vi.fn() });
    emit({ action: "next" });

    expect(onNextV2).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("unmount → gỡ listener + unsubscribe audio (không leak)", async () => {
    const { unmount } = await mount();
    const unsubs = audioMock.on.mock.results.map((r) => r.value as () => void);

    unmount();

    expect(bridgeMock.unlisten).toHaveBeenCalledTimes(1);
    for (const unsub of unsubs) {
      expect(unsub).toHaveBeenCalledTimes(1);
    }
  });
});

describe("useMediaControls app -> OS snapshots", () => {
  it("mount với track → snapshot title/artist/playback/position đúng", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack("t1"),
      isPlaying: false,
    });
    await mount();

    expect(lastSnapshot()).toEqual({
      revision: 1,
      title: "Title t1",
      artist: "Artist t1",
      duration: null,
      playback: "paused",
      position: 0,
    });
  });

  it("track đổi → title mới + revision tăng; hết track → stopped/null", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack("t1"),
      isPlaying: false,
    });
    await mount();

    act(() => {
      usePlayerStore.setState({
        currentTrack: makeTrack("t2"),
        isPlaying: true,
      });
    });
    expect(lastSnapshot()).toMatchObject({
      revision: 2,
      title: "Title t2",
      artist: "Artist t2",
      playback: "playing",
    });

    act(() => {
      usePlayerStore.setState({ currentTrack: null, isPlaying: false });
    });
    expect(lastSnapshot()).toMatchObject({
      revision: 3,
      title: null,
      artist: null,
      playback: "stopped",
      position: null,
    });

    expect(revisions()).toEqual([1, 2, 3]);
  });

  it("duration lấy từ audio khi có, fallback restoreDuration", async () => {
    audioMock.getDuration.mockReturnValue(240);
    usePlayerStore.setState({
      currentTrack: { ...makeTrack("t1"), restoreDuration: 200 },
      isPlaying: true,
    });
    await mount();
    expect(lastSnapshot()).toMatchObject({ duration: 240 });

    audioMock.getDuration.mockReturnValue(0);
    act(() => {
      usePlayerStore.setState({
        currentTrack: { ...makeTrack("t2"), restoreDuration: 200 },
      });
    });
    expect(lastSnapshot()).toMatchObject({ duration: 200 });
  });

  it("position tick throttle 1s + clamp vào duration", async () => {
    vi.useFakeTimers();
    usePlayerStore.setState({ currentTrack: makeTrack("t1"), isPlaying: true });
    audioMock.getCurrentTime.mockReturnValue(30);
    audioMock.getDuration.mockReturnValue(120);
    await mount();

    const tick = audioMock.on.mock.calls.find(
      (c) => c[0] === "timeupdate",
    )?.[1];
    expect(tick).toBeTypeOf("function");
    const callsAfterMount = bridgeMock.update.mock.calls.length;

    act(() => {
      (tick as () => void)();
    });
    expect(bridgeMock.update).toHaveBeenCalledTimes(callsAfterMount + 1);
    expect(lastSnapshot()).toMatchObject({ position: 30, duration: 120 });

    act(() => {
      (tick as () => void)();
    });
    expect(bridgeMock.update).toHaveBeenCalledTimes(callsAfterMount + 1);

    vi.advanceTimersByTime(1000);
    act(() => {
      (tick as () => void)();
    });
    expect(bridgeMock.update).toHaveBeenCalledTimes(callsAfterMount + 2);

    audioMock.getCurrentTime.mockReturnValue(500);
    vi.advanceTimersByTime(1000);
    act(() => {
      (tick as () => void)();
    });
    expect(lastSnapshot()).toMatchObject({ position: 120 });
  });

  it("không có track → không subscribe position tick", async () => {
    await mount();
    expect(audioMock.on).not.toHaveBeenCalledWith(
      "timeupdate",
      expect.any(Function),
    );
  });

  it("R2.1: position tick of ANOTHER track is dropped; the current track's tick pushes", async () => {
    usePlayerStore.setState({ currentTrack: makeTrack("t1"), isPlaying: true });
    audioMock.getCurrentTime.mockReturnValue(30);
    audioMock.getDuration.mockReturnValue(120);
    await mount();

    const tick = audioMock.on.mock.calls.find(
      (c) => c[0] === "timeupdate",
    )?.[1] as ((payload?: unknown) => void) | undefined;
    expect(tick).toBeTypeOf("function");
    const callsAfterMount = bridgeMock.update.mock.calls.length;

    act(() => {
      tick?.({ trackId: "t2", attempt: 9 });
    });
    expect(bridgeMock.update).toHaveBeenCalledTimes(callsAfterMount);

    act(() => {
      tick?.({ trackId: "t1", attempt: 1 });
    });
    expect(bridgeMock.update).toHaveBeenCalledTimes(callsAfterMount + 1);
    expect(lastSnapshot()).toMatchObject({ position: 30, duration: 120 });
  });

  it("R2.1 legacy: an untagged tick still pushes (older sender)", async () => {
    usePlayerStore.setState({ currentTrack: makeTrack("t1"), isPlaying: true });
    audioMock.getCurrentTime.mockReturnValue(30);
    audioMock.getDuration.mockReturnValue(120);
    await mount();

    const tick = audioMock.on.mock.calls.find(
      (c) => c[0] === "timeupdate",
    )?.[1] as ((payload?: unknown) => void) | undefined;
    const callsAfterMount = bridgeMock.update.mock.calls.length;

    act(() => {
      tick?.();
    });
    expect(bridgeMock.update).toHaveBeenCalledTimes(callsAfterMount + 1);
  });
});
