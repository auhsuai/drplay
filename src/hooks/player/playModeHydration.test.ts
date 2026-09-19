// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { del, get, set } from "../../db/kv";
import { getValidToken } from "../../utils/apiClient";
import {
  buildStreamUrl,
  getPrefetchedStreamUrl,
} from "../../utils/streamPrefetcher";
import { captureError } from "../../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../../utils/sessionCleanup";
import { usePlayerStore } from "../../store/playerStore";
import type { Track } from "../../types";
import { usePlayerSession } from "./usePlayerSession";
import { usePlayerLifecycle } from "./usePlayerLifecycle";

vi.mock("tauri-plugin-keepawake-api", () => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../db/kv", () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../../utils/apiClient", () => ({ getValidToken: vi.fn() }));

vi.mock("../../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(),
  DRIVE_STREAM_PREFIX: "/drive-stream/",
  buildStreamUrl: vi.fn(),
}));

vi.mock("../../utils/errorLog", () => ({ captureError: vi.fn() }));

vi.mock("../../lib/AudioController", () => ({
  AudioController: {
    getInstance: vi.fn(() => ({
      release: vi.fn(),
      on: vi.fn(() => () => {}),
      getCurrentTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 0),
    })),
  },
}));

const kvStore = new Map<string, unknown>();
const kvOps: Array<{ op: string; key: string; value?: unknown }> = [];

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: "Artist",
    streamUrl: `/drive-stream/${id}`,
    queueItemId: `q-${id}`,
  };
}

// Mirrors usePlayer's real hook order: usePlayerSession first, then
// usePlayerLifecycle — the order that produced the boot-write clobber.
function useHarness(): void {
  const [hydrated, setHydrated] = useState(false);
  const onHydrated = useCallback(() => {
    setHydrated(true);
  }, []);
  const playMode = usePlayerStore((s) => s.playMode);
  const setPlayMode = usePlayerStore((s) => s.setPlayMode);
  const setCurrentTrack = usePlayerStore((s) => s.setCurrentTrack);
  const setIsPlaying = usePlayerStore((s) => s.setIsPlaying);
  const setOriginalQueue = usePlayerStore((s) => s.setOriginalQueue);
  const setPlaybackQueue = usePlayerStore((s) => s.setPlaybackQueue);
  const triggerReload = usePlayerStore((s) => s.triggerReload);
  const resetBrokenTracks = usePlayerStore((s) => s.resetBrokenTracks);

  usePlayerSession(
    setCurrentTrack,
    setOriginalQueue,
    setPlaybackQueue,
    setPlayMode,
    triggerReload,
    onHydrated,
  );
  usePlayerLifecycle({
    isPlaying: false,
    playMode,
    hydrated,
    setCurrentTrack,
    setIsPlaying,
    setOriginalQueue,
    setPlaybackQueue,
    resetBrokenTracks,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  kvStore.clear();
  kvOps.length = 0;
  vi.mocked(get).mockImplementation((key: string) => {
    kvOps.push({ op: "get", key });
    return Promise.resolve(kvStore.get(key));
  });
  vi.mocked(set).mockImplementation((key: string, value: unknown) => {
    kvOps.push({ op: "set", key, value });
    kvStore.set(key, value);
    return Promise.resolve();
  });
  vi.mocked(del).mockImplementation((key: string) => {
    kvOps.push({ op: "del", key });
    kvStore.delete(key);
    return Promise.resolve();
  });
  vi.mocked(getValidToken).mockResolvedValue("test-token");
  vi.mocked(getPrefetchedStreamUrl).mockReturnValue(undefined);
  vi.mocked(buildStreamUrl).mockImplementation(
    (id: string) => `/drive-stream/${id}`,
  );
  vi.mocked(captureError).mockResolvedValue(undefined);
  usePlayerStore.setState({
    playMode: "normal",
    currentTrack: null,
    isPlaying: false,
    isDownloading: false,
    originalQueue: [],
    playbackQueue: [],
    brokenTrackIds: [],
    errorInfo: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("F7-1 playMode hydration (mount order thật: session trước lifecycle)", () => {
  it("kv shuffle + session track → shuffle thắng, không bao giờ ghi 'normal', queue rebuild shuffle", async () => {
    const queue = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    localStorage.setItem(
      SESSION_CLEANUP_KEYS.lastSessionLocalStorage,
      JSON.stringify({ track: queue[0], time: 12, duration: 240 }),
    );
    kvStore.set(SESSION_CLEANUP_KEYS.queueKv, queue);
    kvStore.set(SESSION_CLEANUP_KEYS.playModeKv, "shuffle");
    vi.spyOn(Math, "random").mockReturnValue(0);

    renderHook(() => {
      useHarness();
    });
    await flush();

    const playModeSets = kvOps.filter(
      (o) => o.op === "set" && o.key === SESSION_CLEANUP_KEYS.playModeKv,
    );
    expect(playModeSets.map((o) => o.value)).toEqual(["shuffle"]);
    expect(kvStore.get(SESSION_CLEANUP_KEYS.playModeKv)).toBe("shuffle");
    expect(usePlayerStore.getState().playMode).toBe("shuffle");
    expect(usePlayerStore.getState().currentTrack?.id).toBe("t1");
    expect(usePlayerStore.getState().playbackQueue.map((t) => t.id)).toEqual([
      "t1",
      "t3",
      "t2",
    ]);
  });

  it("không có session → hydrate vẫn mở gate và kv nhận 'normal' đúng một lần", async () => {
    renderHook(() => {
      useHarness();
    });
    await flush();

    expect(usePlayerStore.getState().playMode).toBe("normal");
    const playModeSets = kvOps.filter(
      (o) => o.op === "set" && o.key === SESSION_CLEANUP_KEYS.playModeKv,
    );
    expect(playModeSets.map((o) => o.value)).toEqual(["normal"]);
  });
});
