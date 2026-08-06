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

// jsdom does not implement the Media Session API (no navigator.mediaSession,
// no MediaMetadata constructor) â€” tests install their own minimal stand-ins.
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

interface MediaSessionActionDetailsLike {
  seekTime?: number;
  seekOffset?: number;
  fastSeek?: boolean;
}

type ActionHandler = (details?: MediaSessionActionDetailsLike) => void;

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
  const handlers = new Map<string, ActionHandler | null>();
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler: vi.fn((action: string, handler: ActionHandler | null) => {
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(navigator, "mediaSession", {
    value: session,
    configurable: true,
    writable: true,
  });
  return {
    session,
    invoke: (action: string, details?: MediaSessionActionDetailsLike) => {
      const handler = handlers.get(action);
      if (handler) handler(details);
    },
  };
}

function removeSessionMock() {
  Object.defineProperty(navigator, "mediaSession", {
    value: undefined,
    configurable: true,
    writable: true,
  });
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
  const onTogglePlay = vi.fn();
  const onNext = vi.fn();
  const onPrev = vi.fn();
  const result = renderHook(
    (rerenderProps?: Partial<UseMediaSessionOptions>) => {
      useMediaSession({
        onTogglePlay,
        onNext,
        onPrev,
        ...options,
        ...rerenderProps,
      });
    },
  );
  return { ...result, onTogglePlay, onNext, onPrev };
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

describe("useMediaSession guard", () => {
  it("khÃ´ng cÃ³ navigator.mediaSession â†’ no-op, khÃ´ng throw (mount + unmount ká»ƒ cáº£ khi cÃ³ track)", () => {
    removeSessionMock();
    usePlayerStore.setState({
      currentTrack: makeTrack("t1"),
      isPlaying: true,
    });

    const { unmount } = makeHook();
    expect(audioMock.on).not.toHaveBeenCalled();
    unmount();
  });
});

describe("useMediaSession metadata", () => {
  it("currentTrack â†’ metadata title/artist tháº­t; album/artwork KHÃ”NG bá»‹a (bá» trá»‘ng)", () => {
    const { session } = installSessionMock();
    usePlayerStore.setState({ currentTrack: makeTrack("t1") });

    makeHook();

    expect(session.metadata?.title).toBe("Title t1");
    expect(session.metadata?.artist).toBe("Artist t1");
    expect(session.metadata?.album).toBe("");
    expect(session.metadata?.artwork).toEqual([]);
  });

  it("currentTrack Ä‘á»•i â†’ metadata cáº­p nháº­t; currentTrack null â†’ metadata null", () => {
    const { session } = installSessionMock();
    makeHook();

    act(() => {
      usePlayerStore.setState({ currentTrack: makeTrack("t1") });
    });
    expect(session.metadata?.title).toBe("Title t1");

    act(() => {
      usePlayerStore.setState({ currentTrack: makeTrack("t2") });
    });
    expect(session.metadata?.title).toBe("Title t2");

    act(() => {
      usePlayerStore.setState({ currentTrack: null });
    });
    expect(session.metadata).toBeNull();
  });
});

describe("useMediaSession playbackState", () => {
  it("khÃ´ng track â†’ none; track + !isPlaying â†’ paused; isPlaying â†’ playing", () => {
    const { session } = installSessionMock();
    makeHook();
    expect(session.playbackState).toBe("none");

    act(() => {
      usePlayerStore.setState({ currentTrack: makeTrack("t1") });
    });
    expect(session.playbackState).toBe("paused");

    act(() => {
      usePlayerStore.setState({ isPlaying: true });
    });
    expect(session.playbackState).toBe("playing");

    act(() => {
      usePlayerStore.setState({ isPlaying: false });
    });
    expect(session.playbackState).toBe("paused");
  });
});

describe("useMediaSession action handlers", () => {
  it("play: Ä‘ang paused â†’ gá»i onTogglePlay; Ä‘ang playing â†’ khÃ´ng gá»i", () => {
    const { invoke } = installSessionMock();
    usePlayerStore.setState({ currentTrack: makeTrack("t1") });
    const { onTogglePlay } = makeHook();

    act(() => {
      invoke("play");
    });
    expect(onTogglePlay).toHaveBeenCalledTimes(1);

    act(() => {
      usePlayerStore.setState({ isPlaying: true });
    });
    act(() => {
      invoke("play");
    });
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("pause: Ä‘ang playing â†’ audio.pause(); Ä‘ang paused â†’ khÃ´ng gá»i", () => {
    const { invoke } = installSessionMock();
    usePlayerStore.setState({ currentTrack: makeTrack("t1"), isPlaying: true });
    makeHook();

    act(() => {
      invoke("pause");
    });
    expect(audioMock.pause).toHaveBeenCalledTimes(1);

    act(() => {
      usePlayerStore.setState({ isPlaying: false });
    });
    act(() => {
      invoke("pause");
    });
    expect(audioMock.pause).toHaveBeenCalledTimes(1);
  });

  it("nexttrack â†’ onNext; previoustrack â†’ onPrev", () => {
    const { invoke } = installSessionMock();
    const { onNext, onPrev } = makeHook();

    act(() => {
      invoke("nexttrack");
    });
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();

    act(() => {
      invoke("previoustrack");
    });
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("seekto â†’ audio.seek(seekTime) + setPositionState(duration, position, playbackRate 1)", () => {
    const { session, invoke } = installSessionMock();
    audioMock.getCurrentTime.mockReturnValue(42);
    audioMock.getDuration.mockReturnValue(240);
    makeHook();

    act(() => {
      invoke("seekto", { seekTime: 120 });
    });
    expect(audioMock.seek).toHaveBeenCalledWith(120);
    expect(session.setPositionState).toHaveBeenCalledWith({
      duration: 240,
      position: 42,
      playbackRate: 1,
    });
  });

  it("seekto thiáº¿u seekTime â†’ khÃ´ng gá»i audio.seek (no-op an toÃ n)", () => {
    const { invoke } = installSessionMock();
    makeHook();

    act(() => {
      invoke("seekto", {});
    });
    expect(audioMock.seek).not.toHaveBeenCalled();
  });

  it("seekbackward/seekforward: dÃ¹ng seekOffset náº¿u cÃ³; fallback SEEK_STEP 5s; clamp [0, duration]", () => {
    const { session, invoke } = installSessionMock();
    audioMock.getCurrentTime.mockReturnValue(30);
    audioMock.getDuration.mockReturnValue(120);
    makeHook();

    act(() => {
      invoke("seekbackward", { seekOffset: 10 });
    });
    expect(audioMock.seek).toHaveBeenLastCalledWith(20);

    act(() => {
      invoke("seekbackward", {});
    });
    expect(audioMock.seek).toHaveBeenLastCalledWith(25);

    act(() => {
      invoke("seekbackward", { seekOffset: 50 });
    });
    expect(audioMock.seek).toHaveBeenLastCalledWith(0);

    act(() => {
      invoke("seekforward", { seekOffset: 10 });
    });
    expect(audioMock.seek).toHaveBeenLastCalledWith(40);

    act(() => {
      invoke("seekforward", {});
    });
    expect(audioMock.seek).toHaveBeenLastCalledWith(35);

    act(() => {
      invoke("seekforward", { seekOffset: 200 });
    });
    expect(audioMock.seek).toHaveBeenLastCalledWith(120);

    expect(session.setPositionState).toHaveBeenCalledTimes(6);
  });

  it("handlers Ä‘Äƒng kÃ½ ÄÃšNG 1 láº§n khi mount (track/isPlaying Ä‘á»•i khÃ´ng re-register)", () => {
    const { session } = installSessionMock();
    makeHook();

    const perAction = MEDIA_ACTIONS.map(
      (a) =>
        session.setActionHandler.mock.calls.filter((c) => c[0] === a).length,
    );
    expect(perAction).toEqual(MEDIA_ACTIONS.map(() => 1));

    act(() => {
      usePlayerStore.setState({
        currentTrack: makeTrack("t1"),
        isPlaying: true,
      });
    });
    expect(
      MEDIA_ACTIONS.map(
        (a) =>
          session.setActionHandler.mock.calls.filter((c) => c[0] === a).length,
      ),
    ).toEqual(perAction);
  });

  it("handler dÃ¹ng callback má»›i nháº¥t sau rerender (ref sync)", () => {
    const { invoke } = installSessionMock();
    const { rerender, onNext } = makeHook();
    const onNextV2 = vi.fn();

    rerender({
      onTogglePlay: vi.fn(),
      onNext: onNextV2,
      onPrev: vi.fn(),
    });

    act(() => {
      invoke("nexttrack");
    });
    expect(onNextV2).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });
});
