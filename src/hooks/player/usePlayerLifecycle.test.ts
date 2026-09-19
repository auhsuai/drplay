// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  start as keepAwakeStart,
  stop as keepAwakeStop,
} from "tauri-plugin-keepawake-api";
import { PLAYER_STOP_EVENT, usePlayerLifecycle } from "./usePlayerLifecycle";
import type { PlayerLifecycleDeps } from "./usePlayerLifecycle";
import { set as idbSet } from "../../db/kv";
import { PLAYER_PERSISTENCE_KEYS } from "../../utils/playerPersistence";
import { usePlayerStore } from "../../store/playerStore";
import {
  guardAllowsAutoAdvance,
  noteFormatError,
  resetAdvanceGuard,
} from "../../utils/playerError";
import {
  armRestoreResume,
  clearRestoreResume,
  consumeRestoreResume,
} from "./restoreResume";

vi.mock("tauri-plugin-keepawake-api", () => ({
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../db/kv", () => ({
  set: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => ({ release: vi.fn() }) },
}));

const makeDeps = (isPlaying: boolean) => ({
  isPlaying,
  playMode: "normal" as const,
  hydrated: true,
  setCurrentTrack: vi.fn(),
  setIsPlaying: vi.fn(),
  setOriginalQueue: vi.fn(),
  setPlaybackQueue: vi.fn(),
  resetBrokenTracks: vi.fn(),
});

const renderLifecycle = (isPlaying: boolean) =>
  renderHook(
    (props: { isPlaying: boolean }) => {
      usePlayerLifecycle(makeDeps(props.isPlaying));
    },
    { initialProps: { isPlaying } },
  );

// Lets the queued keep-awake promise chain run inside act.
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  usePlayerStore.setState({ isDownloading: false });
  clearRestoreResume();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePlayerLifecycle keep-awake cleanup", () => {
  it("UPL-1: unmount while playing releases keep-awake (stop called from cleanup)", async () => {
    const { unmount } = renderLifecycle(true);

    await flush();

    expect(vi.mocked(keepAwakeStart)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(keepAwakeStop)).not.toHaveBeenCalled();

    unmount();

    await flush();

    expect(vi.mocked(keepAwakeStop)).toHaveBeenCalledTimes(1);
    const startOrder =
      vi.mocked(keepAwakeStart).mock.invocationCallOrder[0] ?? 0;
    const stopOrder = vi.mocked(keepAwakeStop).mock.invocationCallOrder[0] ?? 0;
    expect(stopOrder).toBeGreaterThan(startOrder);
  });

  it("UPL-1: stop is serialized behind a still-pending start (no interleave)", async () => {
    let resolveStart!: (value: string | null) => void;
    vi.mocked(keepAwakeStart).mockReturnValue(
      new Promise<string | null>((r) => {
        resolveStart = r;
      }),
    );

    const { rerender } = renderLifecycle(true);

    await flush();

    expect(vi.mocked(keepAwakeStart)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(keepAwakeStop)).not.toHaveBeenCalled();

    rerender({ isPlaying: false });

    // The plugin's promises may resolve out of order; stop must wait for the
    // pending start instead of overtaking it.
    expect(vi.mocked(keepAwakeStop)).not.toHaveBeenCalled();

    await act(async () => {
      resolveStart(null);
      await Promise.resolve();
    });

    expect(vi.mocked(keepAwakeStop)).toHaveBeenCalled();
    const startOrder =
      vi.mocked(keepAwakeStart).mock.invocationCallOrder[0] ?? 0;
    const stopOrder = vi.mocked(keepAwakeStop).mock.invocationCallOrder[0] ?? 0;
    expect(stopOrder).toBeGreaterThan(startOrder);
  });
});

describe("usePlayerLifecycle playMode hydration gate (F7-1)", () => {
  it("UPL-3: chưa hydrate → không ghi playMode; hydrate xong → ghi giá trị hiện tại", async () => {
    vi.mocked(idbSet).mockImplementation(() => Promise.resolve());
    const deps: PlayerLifecycleDeps = {
      ...makeDeps(false),
      playMode: "shuffle" as const,
      hydrated: false,
    };
    const { rerender } = renderHook(
      (props: { deps: PlayerLifecycleDeps }) => {
        usePlayerLifecycle(props.deps);
      },
      { initialProps: { deps } },
    );
    await flush();

    expect(vi.mocked(idbSet)).not.toHaveBeenCalled();

    rerender({ deps: { ...deps, hydrated: true } });
    await flush();

    expect(vi.mocked(idbSet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(idbSet)).toHaveBeenCalledWith(
      PLAYER_PERSISTENCE_KEYS.playMode,
      { v: 2, mode: "shuffle" },
    );
  });
});

describe("usePlayerLifecycle player-stop hard reset", () => {
  it("UPL-2: player-stop while a load is in flight clears isDownloading immediately", () => {
    usePlayerStore.setState({ isDownloading: true });
    const deps = makeDeps(false);
    const { unmount } = renderHook(() => {
      usePlayerLifecycle(deps);
    });

    act(() => {
      window.dispatchEvent(new Event(PLAYER_STOP_EVENT));
    });

    expect(usePlayerStore.getState().isDownloading).toBe(false);
    expect(deps.setCurrentTrack).toHaveBeenCalledWith(null);
    expect(deps.setIsPlaying).toHaveBeenCalledWith(false);
    expect(deps.setOriginalQueue).toHaveBeenCalledWith([]);
    expect(deps.setPlaybackQueue).toHaveBeenCalledWith([]);
    expect(deps.resetBrokenTracks).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("UPL-4 (F8-4): player-stop hard resets the advance storm guard — session sau không kế thừa block", () => {
    resetAdvanceGuard();
    const now = Date.now();
    noteFormatError(now);
    noteFormatError(now);
    expect(noteFormatError(now)).toBe(true);
    expect(guardAllowsAutoAdvance(now)).toBe(false);

    const deps = makeDeps(false);
    const { unmount } = renderHook(() => {
      usePlayerLifecycle(deps);
    });

    act(() => {
      window.dispatchEvent(new Event(PLAYER_STOP_EVENT));
    });

    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);

    unmount();
  });

  it("UPL-5 (F7-6): player-stop clears the one-shot restore hint — session sau không resume về vị trí cũ", () => {
    armRestoreResume("t1", 12);

    const deps = makeDeps(false);
    const { unmount } = renderHook(() => {
      usePlayerLifecycle(deps);
    });

    act(() => {
      window.dispatchEvent(new Event(PLAYER_STOP_EVENT));
    });

    expect(consumeRestoreResume("t1")).toBeUndefined();

    unmount();
  });
});
