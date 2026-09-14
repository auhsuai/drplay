// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  start as keepAwakeStart,
  stop as keepAwakeStop,
} from "tauri-plugin-keepawake-api";
import { usePlayerLifecycle } from "./usePlayerLifecycle";

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
