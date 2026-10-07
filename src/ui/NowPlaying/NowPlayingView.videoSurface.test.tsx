// @vitest-environment jsdom
/**
 * VideoSurface INTEGRATION in the Now Playing view: which track kinds get the
 * surface at all, and the show/hide matrix the native host follows.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { NowPlayingView } from "./NowPlayingView";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const audioMock = vi.hoisted(() => {
  const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
  return {
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
      return () => {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      };
    }),
    _emit(event: string, payload?: unknown) {
      for (const h of handlers[event] ?? []) h(payload);
    },
    playTrack: vi.fn(() => Promise.resolve()),
    // VolumeSlider reads the engine through the same facade.
    getVolume: vi.fn(() => 0.5),
    isMuted: vi.fn(() => false),
    toggleMute: vi.fn(() => false),
    setVolume: vi.fn(),
  };
});
vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

const storeState = vi.hoisted(() => ({
  isDownloading: false,
  errorInfo: null as { code: string; message: string } | null,
  currentTrack: null as { id: string; title: string } | null,
}));
vi.mock("../../store/playerStore", () => {
  const usePlayerStore = (selector: (s: typeof storeState) => unknown) =>
    selector(storeState);
  return {
    usePlayerStore: Object.assign(usePlayerStore, {
      getState: () => storeState,
    }),
  };
});

vi.mock("./hooks/useNowPlayingMetadata", () => ({
  useNowPlayingMetadata: () => ({
    coverUrl: null,
    setCoverUrl: vi.fn(),
    realTitle: "Title",
    realArtist: "Artist",
    bgColor: null,
    bgPalette: [],
  }),
}));
vi.mock("../components/SeekBar", () => ({ SeekBar: () => null }));

const AUDIO: Track = {
  id: "a",
  title: "Song.mp3",
  artist: "Artist",
  streamUrl: "/drive-stream/a",
};
const VIDEO: Track = {
  id: "v",
  title: "Movie",
  artist: "",
  streamUrl: "/drive-stream/v",
  originalName: "Movie.mkv",
};
const VIDEO_2: Track = { ...VIDEO, id: "v2", originalName: "Other.MP4" };

function baseProps() {
  return {
    currentTrack: null as Track | null,
    isPlaying: false,
    onTogglePlay: vi.fn(),
    onNextTrack: vi.fn(),
    onPrevTrack: vi.fn(),
    playMode: "normal" as const,
    onTogglePlayMode: vi.fn(),
    onBack: vi.fn(),
    isOpen: true,
    token: "tok",
    isShellLocked: false,
  };
}

function visibleCalls(): boolean[] {
  return (
    tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >
  )
    .filter((call) => call[0] === "video_host_set_visible")
    .map((call) => call[1]["visible"] as boolean);
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockResolvedValue(undefined);
  storeState.errorInfo = null;
  storeState.currentTrack = null;
});

afterEach(() => {
  cleanup();
  audioMock.getVolume.mockReturnValue(0.5);
  audioMock.isMuted.mockReturnValue(false);
});

describe("the surface renders for video only", () => {
  it("an AUDIO track keeps the cover-art square and gets NO video surface", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={AUDIO} />,
    );

    expect(container.querySelector("[data-testid='video-surface']")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
    expect(visibleCalls()).toEqual([]);
  });

  it("a VIDEO track replaces it with the measured surface and shows the host", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );

    expect(
      container.querySelector("[data-testid='video-surface']"),
    ).not.toBeNull();
    expect(container.querySelector(".lucide-music")).toBeNull();
    expect(visibleCalls()).toEqual([true]);
  });

  it("classification uses originalName (Drive name); a title-only track stays audio", () => {
    // "Movie" carries no video extension, so with no originalName the track is
    // audio and no surface is rendered. (originalName is simply absent — exact
    // OptionalPropertyTypes forbids spelling it as `undefined`.)
    const noOriginalName: Track = {
      id: "v",
      title: "Movie",
      artist: "",
      streamUrl: "/drive-stream/v",
    };
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={noOriginalName} />,
    );
    expect(container.querySelector("[data-testid='video-surface']")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fullscreen (TASK 1). Fullscreen is a REFINEMENT of the Now Playing overlay:
// the same surface, DrPlay's own controls, only bigger — never a second
// surface and never a top-level mpv window.
// ---------------------------------------------------------------------------
describe("fullscreen: a refinement of the Now Playing overlay", () => {
  function surfaceBox(container: HTMLElement): HTMLElement {
    const box = container.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    );
    if (!box) throw new Error("video surface not rendered");
    return box;
  }

  it("a VIDEO track offers the fullscreen toggle; an AUDIO track does NOT", () => {
    const video = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(
      video.container.querySelector("[data-testid='fullscreen-toggle']"),
    ).not.toBeNull();
    video.unmount();

    const audio = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={AUDIO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    // Fullscreen exists for the VIDEO surface. Offer it for audio and it
    // enlarges the cover-art square, which is not what the user asked for.
    expect(
      audio.container.querySelector("[data-testid='fullscreen-toggle']"),
    ).toBeNull();
  });

  it("no track -> no fullscreen toggle (nothing to enlarge)", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} onToggleFullscreen={vi.fn()} />,
    );
    expect(
      container.querySelector("[data-testid='fullscreen-toggle']"),
    ).toBeNull();
  });

  it("entering fullscreen swaps the surface size class and KEEPS the controls", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const before = surfaceBox(container).className;
    expect(before).toContain("xl:w-[min(560px,60vh)]");

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(surfaceBox(container).className).toContain("w-full");
    // DrPlay's own chrome is still there — fullscreen does not hide it.
    expect(container.querySelector("button.bg-brand-primary")).not.toBeNull();
    expect(
      container.querySelector("[data-testid='fullscreen-toggle']"),
    ).not.toBeNull();
    // Still exactly ONE surface.
    expect(
      container.querySelectorAll("[data-testid='video-surface']"),
    ).toHaveLength(1);
  });

  it("the toggle is reachable in fullscreen to leave again (back-button styling)", () => {
    const props = baseProps();
    const { container } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      "[data-testid='fullscreen-toggle']",
    );
    if (!toggle) throw new Error("fullscreen toggle not rendered");
    // Same affordance language as the back button it mirrors.
    expect(toggle.className).toContain("text-gray-500");
    expect(toggle.className).toContain("hover:text-gray-900");
    expect(toggle.className).toContain("dark:hover:text-white");
    expect(toggle.className).toContain("active:scale-95");
  });

  it("clicking the toggle asks the owner to toggle (App owns the state)", () => {
    const onToggleFullscreen = vi.fn();
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      "[data-testid='fullscreen-toggle']",
    );
    if (!toggle) throw new Error("fullscreen toggle not rendered");

    fireEvent.click(toggle);

    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it("fullscreen NEVER toggles host visibility (same surface, same owner rule)", () => {
    const props = baseProps();
    const { rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    const afterEnter = visibleCalls();

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );

    // No extra show/hide churn: the host was already up and stays up.
    expect(visibleCalls()).toEqual(afterEnter);
    expect(visibleCalls()).toEqual([true]);
  });

  it("leaving fullscreen restores the capped size and keeps the host up", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(surfaceBox(container).className).toContain("w-full");

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(surfaceBox(container).className).toContain("xl:w-[min(560px,60vh)]");
    expect(visibleCalls()).toEqual([true]);
  });

  it("an errored video still shows the retry surface (no fullscreen offer is not an excuse to hide it)", () => {
    storeState.errorInfo = { code: "format_error", message: "x" };
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(container.querySelector(".lucide-refresh-cw")).not.toBeNull();
    expect(visibleCalls()).toEqual([false]);
  });
});

describe("host visibility matrix", () => {
  /** Last state the host was put into; false when it was never touched. */
  function hostVisible(): boolean {
    const calls = visibleCalls();
    return calls.length === 0 ? false : (calls[calls.length - 1] ?? false);
  }

  const cases: Array<
    [
      string,
      {
        track: Track | null;
        isOpen?: boolean;
        locked?: boolean;
        error?: boolean;
      },
      boolean,
    ]
  > = [
    ["video + open + healthy", { track: VIDEO }, true],
    ["video + overlay closed", { track: VIDEO, isOpen: false }, false],
    ["audio + open", { track: AUDIO }, false],
    [
      "video + shell locked (login/folder modal)",
      { track: VIDEO, locked: true },
      false,
    ],
    ["video + error", { track: VIDEO, error: true }, false],
    ["no track", { track: null }, false],
  ];

  it.each(cases)("%s -> host visible = %s", (_label, cfg, expected) => {
    storeState.errorInfo = cfg.error
      ? { code: "network_interrupted", message: "x" }
      : null;
    render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={cfg.track}
        isOpen={cfg.isOpen ?? true}
        isShellLocked={cfg.locked ?? false}
      />,
    );

    expect(hostVisible()).toBe(expected);
  });

  it("video -> video: the host STAYS (no hide/show churn, no flicker)", () => {
    const { rerender } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    rerender(<NowPlayingView {...baseProps()} currentTrack={VIDEO_2} />);

    expect(visibleCalls()).toEqual([true]);
  });

  it("video -> audio hides the host exactly once, then mpv's own video=no runs", () => {
    const { rerender } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    rerender(<NowPlayingView {...baseProps()} currentTrack={AUDIO} />);

    expect(visibleCalls()).toEqual([true, false]);
  });

  it("video -> no track (overlay empties) hides the host too", () => {
    const { rerender } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    rerender(<NowPlayingView {...baseProps()} currentTrack={null} />);

    expect(visibleCalls()).toEqual([true, false]);
  });

  it("audio -> video -> video: ONE show, no intermediate hide", () => {
    const { rerender } = render(
      <NowPlayingView {...baseProps()} currentTrack={AUDIO} />,
    );
    rerender(<NowPlayingView {...baseProps()} currentTrack={VIDEO} />);
    rerender(<NowPlayingView {...baseProps()} currentTrack={VIDEO_2} />);

    expect(visibleCalls()).toEqual([true]);
  });
});

// ---------------------------------------------------------------------------
// Ended state (TASK 4 / F5). `end-file` already reaches the app as the
// `ended` engine event (mpvProtocol -> mpvAudio -> AudioController.on("ended")),
// which is what drives auto-advance. The surface now listens to the SAME event
// so a finished video stops presenting a live-looking surface while the queue
// advances, instead of freezing on its last frame.
// ---------------------------------------------------------------------------
describe("ended: the surface stops looking live", () => {
  function spinner(container: HTMLElement): Element | null {
    return (
      container
        .querySelector("[data-testid='video-surface']")
        ?.querySelector("svg.lucide-loader-circle") ?? null
    );
  }

  /** Render a healthy, buffering, PLAYING video: the one state in which the
   *  placeholder's loading affordance is legitimately on. */
  function bufferingVideo(): {
    container: HTMLElement;
    rerender: (el: React.ReactElement) => void;
  } {
    storeState.currentTrack = VIDEO;
    const view = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} isPlaying />,
    );
    act(() => {
      audioMock._emit("buffering", {
        isBuffering: true,
        trackId: VIDEO.id,
        attempt: 1,
      });
    });
    return view;
  }

  it("the CURRENT track's `ended` hides the host (no frozen last frame)", () => {
    const { container } = bufferingVideo();
    expect(visibleCalls()).toEqual([true]);
    expect(spinner(container)).not.toBeNull();

    act(() => {
      audioMock._emit("ended", { trackId: VIDEO.id, attempt: 1 });
    });

    expect(visibleCalls()).toEqual([true, false]);
    expect(spinner(container)).toBeNull();
  });

  it("`ended` of ANOTHER track is ignored (identity guard, like buffering)", () => {
    const { container } = bufferingVideo();

    act(() => {
      audioMock._emit("ended", { trackId: "some-other-track", attempt: 9 });
    });

    expect(visibleCalls()).toEqual([true]);
    expect(spinner(container)).not.toBeNull();
  });

  it("a new track clears the ended state, so the next video plays normally", () => {
    const props = baseProps();
    const { container, rerender } = bufferingVideo();
    act(() => {
      audioMock._emit("ended", { trackId: VIDEO.id, attempt: 1 });
    });
    expect(visibleCalls()).toEqual([true, false]);
    expect(spinner(container)).toBeNull();

    storeState.currentTrack = VIDEO_2;
    rerender(<NowPlayingView {...props} currentTrack={VIDEO_2} isPlaying />);

    expect(visibleCalls()).toEqual([true, false, true]);
    // Still buffering (the engine never sent a settle for it here), so the
    // loading affordance is legitimately back.
    expect(spinner(container)).not.toBeNull();
  });

  it("an untagged `ended` (no identity) still ends the current surface", () => {
    storeState.currentTrack = VIDEO;
    render(<NowPlayingView {...baseProps()} currentTrack={VIDEO} isPlaying />);

    act(() => {
      audioMock._emit("ended");
    });

    expect(visibleCalls()).toEqual([true, false]);
  });

  it("paused playback that ends never spins in the first place (F2 + F5 together)", () => {
    storeState.currentTrack = VIDEO;
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        isPlaying={false}
      />,
    );
    // Paused and not buffering: no spinner before the track even finishes.
    expect(spinner(container)).toBeNull();

    act(() => {
      audioMock._emit("ended", { trackId: VIDEO.id, attempt: 1 });
    });

    expect(spinner(container)).toBeNull();
    expect(visibleCalls()).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// Volume in the player surface (TASK 3 / F3). The PlayerBar collapses to h-0
// while the overlay is open, so during full-screen playback there was no way
// to change volume at all. The EXISTING VolumeSlider is reused (not a second
// control), and the PlayerBar keeps its own untouched.
// ---------------------------------------------------------------------------
describe("volume is reachable in the player surface", () => {
  it("renders the shared VolumeSlider rail inside the surface", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    // Same data-testid as the PlayerBar's, so it is provably the same control.
    expect(
      container.querySelector("[data-testid='volume-bar']"),
    ).not.toBeNull();
  });

  it("is present for AUDIO too — the whole surface lacked volume, not just video", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={AUDIO} />,
    );
    expect(
      container.querySelector("[data-testid='volume-bar']"),
    ).not.toBeNull();
  });

  it("the rail is REACHABLE here: the PlayerBar hides its track below xl", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    const rail = container.querySelector<HTMLElement>(
      "[data-testid='volume-bar']",
    );
    if (!rail) throw new Error("volume rail not rendered");
    // PlayerBar's copy is `hidden xl:flex` (1024x768 window -> never reaches
    // xl). In the surface it must be unconditionally visible.
    expect(rail.className).not.toContain("hidden");
    expect(rail.className).toContain("flex");
  });

  it("stays present in fullscreen", () => {
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(
      container.querySelector("[data-testid='volume-bar']"),
    ).not.toBeNull();
  });
});
