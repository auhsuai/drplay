// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useMediaSession,
  type UseMediaSessionOptions,
} from "./useMediaSession";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "../types";

const audioMock = vi.hoisted(() => ({
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 0),
  seek: vi.fn(),
  pause: vi.fn(),
  togglePlay: vi.fn(),
  on: vi.fn<(event: string, handler: () => void) => () => void>(() => vi.fn()),
}));

vi.mock("../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

// jsdom does not implement the Media Session API — tests install their own.
class MediaMetadataMock implements MediaMetadata {
  title = "";
  artist = "";
  album = "";
  artwork: MediaImage[] = [];
  constructor(init?: MediaMetadataInit) {
    this.title = init?.title ?? "";
    this.artist = init?.artist ?? "";
    this.album = init?.album ?? "";
    this.artwork = init?.artwork ?? [];
  }
}

const MEDIA_ACTIONS = [
  "play",
  "pause",
  "nexttrack",
  "previoustrack",
  "seekto",
  "seekbackward",
  "seekforward",
] as const;

function installSessionMock() {
  const handlers = new Map<string, (() => void) | null>();
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler: vi.fn((action: string, handler: (() => void) | null) => {
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(navigator, "mediaSession", {
    value: session,
    configurable: true,
    writable: true,
  });
  return { session };
}

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    streamUrl: `https://stream.example/${id}`,
  };
}

function makeHook(options?: Partial<UseMediaSessionOptions>) {
  return renderHook((rerenderProps?: Partial<UseMediaSessionOptions>) => {
    useMediaSession({
      onTogglePlay: vi.fn(),
      onNext: vi.fn(),
      onPrev: vi.fn(),
      ...options,
      ...rerenderProps,
    });
  });
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
  (globalThis as { MediaMetadata?: unknown }).MediaMetadata = MediaMetadataMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMediaSession position state", () => {
  it("timeupdate (throttle AudioController) → setPositionState đúng duration/position/playbackRate", () => {
    const { session } = installSessionMock();
    audioMock.getCurrentTime.mockReturnValue(30);
    audioMock.getDuration.mockReturnValue(120);
    makeHook();

    const timeHandler = audioMock.on.mock.calls.find(
      (c) => c[0] === "timeupdate",
    )?.[1];
    expect(timeHandler).toBeTypeOf("function");

    act(() => {
      (timeHandler as () => void)();
    });
    expect(session.setPositionState).toHaveBeenCalledWith({
      duration: 120,
      position: 30,
      playbackRate: 1,
    });
  });

  it("guard MDN: duration 0 (chưa có metadata) → KHÔNG gọi setPositionState (tránh TypeError)", () => {
    const { session } = installSessionMock();
    audioMock.getDuration.mockReturnValue(0);
    makeHook();

    const timeHandler = audioMock.on.mock.calls.find(
      (c) => c[0] === "timeupdate",
    )?.[1];
    act(() => {
      (timeHandler as () => void)();
    });
    expect(session.setPositionState).not.toHaveBeenCalled();
  });

  it("guard MDN: position > duration → KHÔNG gọi setPositionState (tránh TypeError)", () => {
    const { session } = installSessionMock();
    audioMock.getCurrentTime.mockReturnValue(130);
    audioMock.getDuration.mockReturnValue(120);
    makeHook();

    const timeHandler = audioMock.on.mock.calls.find(
      (c) => c[0] === "timeupdate",
    )?.[1];
    act(() => {
      (timeHandler as () => void)();
    });
    expect(session.setPositionState).not.toHaveBeenCalled();
  });

  it("subscribe timeupdate + progress (tái dùng throttle AudioController); unsub khi unmount", () => {
    installSessionMock();
    const { unmount } = makeHook();

    expect(audioMock.on.mock.calls.map((c) => c[0])).toEqual([
      "timeupdate",
      "progress",
    ]);

    const unsubs = audioMock.on.mock.results.map((r) => r.value as () => void);
    unmount();
    for (const unsub of unsubs) {
      expect(unsub).toHaveBeenCalledTimes(1);
    }
  });
});

describe("useMediaSession cleanup", () => {
  it("unmount → setActionHandler(null) cho mọi action + metadata null", () => {
    const { session } = installSessionMock();
    usePlayerStore.setState({ currentTrack: makeTrack("t1") });
    const { unmount } = makeHook();
    expect(session.metadata?.title).toBe("Title t1");

    unmount();

    for (const action of MEDIA_ACTIONS) {
      expect(session.setActionHandler).toHaveBeenCalledWith(action, null);
    }
    expect(session.metadata).toBeNull();
  });
});
