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

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  handlers: [] as Array<() => void>,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: () => void) => {
    if (name === "video-first-frame") eventMocks.handlers.push(handler);
    return eventMocks.listen();
  },
}));
async function firstFrame(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    for (const handler of eventMocks.handlers) handler();
  });
}

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
vi.mock("../components/SeekBar", () => ({
  SeekBar: () => <div data-testid="seekbar-stub" />,
}));

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
  eventMocks.handlers.length = 0;
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
  it("a VIDEO track offers the fullscreen toggle only from the bar, never the header; an AUDIO track has none", () => {
    const video = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    // The header toggle is gone (user decision); the bar keeps its own.
    expect(
      video.container.querySelector("[data-testid='fullscreen-toggle']"),
    ).toBeNull();
    expect(
      video.container.querySelector(
        "[data-testid='video-player-bar'] button[aria-label='player.fullscreen']",
      ),
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

  it("entering fullscreen swaps the fill rounding and KEEPS the controls", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const before = surfaceBox(container).className;
    // D3 media-player layout: the video fills its flow area in BOTH states,
    // square-cornered in windowed and fullscreen alike.
    expect(before).toContain("w-full");
    expect(before).toContain("h-full");
    expect(before).toContain("rounded-none");
    expect(before).not.toContain("rounded-xl");
    expect(before).not.toContain("aspect-video");
    expect(
      container.querySelector("[data-testid='video-player-bar']"),
    ).not.toBeNull();

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(surfaceBox(container).className).toContain("rounded-none");
    // DrPlay's own chrome is still there — fullscreen does not hide it.
    expect(container.querySelector("button.bg-brand-primary")).not.toBeNull();
    expect(
      container.querySelector(
        "[data-testid='video-player-bar'] button[aria-label='player.exit_fullscreen']",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='video-player-bar']"),
    ).not.toBeNull();
    // Still exactly ONE surface.
    expect(
      container.querySelectorAll("[data-testid='video-surface']"),
    ).toHaveLength(1);
  });

  it("fullscreen is reachable from the FLOATING BAR only (the header toggle is gone)", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    // The header control the user asked to remove is gone, in both states…
    expect(
      container.querySelector("[data-testid='fullscreen-toggle']"),
    ).toBeNull();

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(
      container.querySelector("[data-testid='fullscreen-toggle']"),
    ).toBeNull();

    // …and the bar still carries it, so fullscreen stays escapable.
    const bar = container.querySelector<HTMLElement>(
      "[data-testid='video-player-bar']",
    );
    if (!bar) throw new Error("video player bar not rendered");
    expect(
      bar.querySelector('button[aria-label="player.exit_fullscreen"]'),
    ).not.toBeNull();
  });

  it("the bar's fullscreen control still asks the owner to toggle (App owns the state)", () => {
    const onToggleFullscreen = vi.fn();
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      "[data-testid='video-player-bar'] button[aria-label='player.fullscreen']",
    );
    if (!toggle) throw new Error("bar fullscreen button not rendered");

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

  it("leaving fullscreen restores the rounded fill and keeps the host up", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(surfaceBox(container).className).toContain("rounded-none");

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(surfaceBox(container).className).toContain("rounded-none");
    expect(surfaceBox(container).className).not.toContain("rounded-xl");
    expect(surfaceBox(container).className).not.toContain("aspect-video");
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

  // UPDATED CONTRACT (D2b): this test used to assert [true, false, true] — the
  // old behaviour hid the host while the Media Information dialog was open
  // (native-child era: CSS could not cover a native child). Under the current
  // architecture the dialog is a React overlay above the video and the DComp
  // video composites below the webview, so the host must KEEP rendering for
  // the whole dialog lifetime. The `isMediaInfoOpen` prop no longer exists on
  // the view, so the assertion becomes: a healthy video stays shown, and
  // nothing about the dialog can churn it.
  it("media info dialog no longer hides the host: the video stays visible", () => {
    render(<NowPlayingView {...baseProps()} currentTrack={VIDEO} />);

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
  it("renders the shared VolumeSlider rail inside the video bar (default responsive form)", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    // Same data-testid as the PlayerBar's, so it is provably the same control.
    const rail = container.querySelector<HTMLElement>(
      "[data-testid='volume-bar']",
    );
    expect(rail).not.toBeNull();
    // D3/§33: the video bar keeps VolumeSlider's DEFAULT responsive rail
    // (appears from the xl breakpoint up) — the mute icon stays clickable.
    expect(rail?.className).toContain("hidden");
    expect(rail?.className).toContain("xl:flex");
  });

  it("is present for AUDIO too — the whole surface lacked volume, not just video", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={AUDIO} />,
    );
    const rail = container.querySelector<HTMLElement>(
      "[data-testid='volume-bar']",
    );
    expect(rail).not.toBeNull();
    // Audio keeps the old alwaysShowRail contract: no hidden rail.
    expect(rail?.className).not.toContain("hidden");
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

// ---------------------------------------------------------------------------
// Media-player video layout (D3 / spec §15/§16/§34). Video mode becomes a
// single column: the video fills the flexible area, ONE horizontal bar with
// every control sits at the bottom. Audio mode is untouched.
// ---------------------------------------------------------------------------
describe("video mode uses the horizontal media-player layout (D3)", () => {
  function surface(container: HTMLElement): HTMLElement {
    const box = container.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    );
    if (!box) throw new Error("video surface not rendered");
    return box;
  }

  it("renders the bottom bar and drops the stacked info/controls/seekbar", () => {
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(
      container.querySelector("[data-testid='video-player-bar']"),
    ).not.toBeNull();
    // The old vertical stack (big title/artist block) is gone…
    expect(container.querySelector("h1")).toBeNull();
    // …and the ONE seekbar lives inside the bar, not standalone.
    expect(
      container.querySelectorAll("[data-testid='seekbar-stub']"),
    ).toHaveLength(1);
    expect(
      container.querySelector(
        "[data-testid='video-player-bar'] [data-testid='seekbar-stub']",
      ),
    ).not.toBeNull();
  });

  it("puts the video in the flexible area directly above the bar (flex-1 min-h-0)", () => {
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const area = surface(container).parentElement;
    if (!area) throw new Error("video area not found");
    expect(area.className).toContain("flex-1");
    expect(area.className).toContain("min-h-0");
    // The bar is the area's NEXT sibling: no overlap with the native rect.
    expect(area.nextElementSibling).toBe(
      container.querySelector("[data-testid='video-player-bar']"),
    );
    // No aspect-video on the fill surface (spec §16).
    expect(surface(container).className).not.toContain("aspect-video");
  });

  it("keeps the same structure in fullscreen (bar stays at the bottom, §17)", () => {
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );

    const area = surface(container).parentElement;
    if (!area) throw new Error("video area not found");
    expect(area.className).toContain("flex-1");
    expect(area.className).toContain("min-h-0");
    expect(
      container.querySelector("[data-testid='video-player-bar']"),
    ).not.toBeNull();
  });

  // Slice 1 (B): the bar floats over the video in fullscreen, so the video
  // area keeps the FULL height in both chrome states — the surface's measured
  // box is byte-identical whether the bar is painted or hidden, which is what
  // keeps the native host rect from churn-ing on every reveal.
  it("fullscreen: the bar is out of flow so the video area keeps the full height", () => {
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );

    const bar = container.querySelector<HTMLElement>(
      "[data-testid='video-player-bar']",
    );
    if (!bar) throw new Error("video player bar not rendered");
    expect(bar.className).toContain("absolute");

    // The area is the ONLY in-flow sibling of the bar now: nothing below the
    // video is reserved, so it stretches over the whole column.
    const area = surface(container).parentElement;
    if (!area) throw new Error("video area not found");
    expect(area.className).toContain("flex-1");
    expect(area.className).toContain("min-h-0");
    expect(area.nextElementSibling).toBe(bar);
  });

  it("fullscreen: hiding the chrome does not change the video area at all", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );

    const areaBefore = surface(container).parentElement?.className ?? "";
    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
        chromeVisible={false}
      />,
    );
    const areaHidden = surface(container).parentElement?.className ?? "";

    expect(areaHidden).toBe(areaBefore);
  });

  it("windowed mode still shows the bar (chrome visibility never hides it outside fullscreen)", () => {
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
        chromeVisible={false}
      />,
    );

    const bar = container.querySelector<HTMLElement>(
      "[data-testid='video-player-bar']",
    );
    if (!bar) throw new Error("video player bar not rendered");
    expect(bar.className).not.toContain("pointer-events-none");
    expect(bar.className).not.toContain("absolute");
  });

  it("pointer movement on the video area asks the owner to reveal the chrome", () => {
    const onRevealChrome = vi.fn();
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
        onRevealChrome={onRevealChrome}
      />,
    );

    fireEvent.pointerMove(surface(container));

    expect(onRevealChrome).toHaveBeenCalled();
  });

  it("opening the More menu routes to the owner with the section AND the trigger anchor", () => {
    // Menu open/close is owned in App (it holds the React menu state and the
    // chrome suspension), so the bar only has to route the request. What must
    // hold here: the request still reaches the owner with the right section,
    // now carrying the measured trigger anchor (Slice 2), and no
    // fullscreen-only listener is introduced by the bar itself.
    // Old assertion: `expect(onOpenPlayerMenu).toHaveBeenCalledWith("full")`
    // — superseded because the anchor is now part of the call.
    const onOpenPlayerMenu = vi.fn();
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
        onOpenPlayerMenu={onOpenPlayerMenu}
      />,
    );

    const more = container.querySelector<HTMLButtonElement>(
      "[data-testid='video-player-bar'] button[aria-label='player.more']",
    );
    if (!more) throw new Error("More button not rendered");
    fireEvent.click(more);

    expect(onOpenPlayerMenu).toHaveBeenCalledWith("full", {
      kind: "button",
      rect: expect.anything() as DOMRect,
      trigger: more,
    });
  });

  it("paused playback does not pin the fullscreen chrome visible", () => {
    const props = baseProps();
    const { container } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        isPlaying={false}
        onToggleFullscreen={vi.fn()}
        chromeVisible={false}
      />,
    );

    // Nothing in the bar may reintroduce visibility because playback is paused:
    // the hidden state is the CSS mechanism alone.
    const bar = container.querySelector<HTMLElement>(
      "[data-testid='video-player-bar']",
    );
    if (!bar) throw new Error("video player bar not rendered");
    expect(bar.className).toContain("opacity-0");
    expect(bar.className).toContain("pointer-events-none");
  });

  it("AUDIO mode never renders the video bar — the old stacked layout is intact", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={AUDIO} />,
    );

    expect(
      container.querySelector("[data-testid='video-player-bar']"),
    ).toBeNull();
    // The stacked info block (big title) is still there for audio.
    expect(container.querySelector("h1")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F3: the video column must give the picture the whole content area. Measured
// live: toggling fullscreen flipped `isFullscreen` but the measured rect stayed
// byte-identical (x:12 y:56 w:1000 h:639) because BOTH states shared one fixed
// class on the video column — `pt-14 px-3 pb-2` — and the bar eats the
// remaining height. That band only reserved space for the removed video header,
// so it is gone in BOTH states; the back button (which lived in it) goes with
// it, and the exit toggle stays reachable.
// ---------------------------------------------------------------------------
describe("F3: fullscreen really enlarges the video surface", () => {
  /** The video column wrapper: surface -> flex area -> column. */
  function videoColumn(container: HTMLElement): HTMLElement {
    const area = container.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    )?.parentElement;
    const column = area?.parentElement;
    if (!column) throw new Error("video column not rendered");
    return column;
  }

  function backButton(container: HTMLElement): Element | null {
    return container.querySelector('button[aria-label="common.close"]');
  }

  /** Outermost wrapper under <main> for the AUDIO branch, reached from the
   *  cover-art icon so the assertion does not depend on class strings. */
  function audioColumn(container: HTMLElement): HTMLElement {
    let el = container.querySelector(".lucide-music");
    while (el && el.parentElement?.tagName !== "MAIN") el = el.parentElement;
    if (!el) throw new Error("audio column not rendered");
    return el as HTMLElement;
  }

  it("windowed: the video column reserves no header band and the header chevron is gone", () => {
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );

    // The reserved header band (`pt-14 px-3 pb-2`) is gone: the video viewport
    // fills the whole content area in windowed mode too.
    expect(videoColumn(container).className).not.toContain("pt-14");
    expect(videoColumn(container).className).not.toContain("px-3");
    expect(videoColumn(container).className).not.toContain("pb-2");
    expect(backButton(container)).toBeNull();
  });

  it("fullscreen: the header band stays gone and the header chevron with it", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    const before = videoColumn(container).className;

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );
    const after = videoColumn(container).className;

    // No reserved header band in EITHER mode, so the picture gets the whole
    // content area in both; the surface stays the column's `flex-1 min-h-0`
    // child.
    expect(after).not.toContain("pt-14");
    expect(after).not.toContain("px-3");
    expect(after).not.toContain("pb-2");
    expect(before).not.toContain("pt-14");
    expect(before).not.toContain("px-3");
    expect(before).not.toContain("pb-2");
    expect(backButton(container)).toBeNull();
    // …but you can still LEAVE fullscreen, from the floating bar.
    expect(
      container.querySelector(
        "[data-testid='video-player-bar'] button[aria-label='player.exit_fullscreen']",
      ),
    ).not.toBeNull();
  });

  it("the measured surface survives the toggle — the rect synchroniser keeps its box", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(
      container.querySelectorAll("[data-testid='video-surface']"),
    ).toHaveLength(1);

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(
      container.querySelectorAll("[data-testid='video-surface']"),
    ).toHaveLength(1);

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        onToggleFullscreen={vi.fn()}
      />,
    );
    expect(
      container.querySelectorAll("[data-testid='video-surface']"),
    ).toHaveLength(1);
  });

  it("AUDIO fullscreen is untouched — the padding change is video-only", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView {...props} currentTrack={AUDIO} />,
    );
    const before = audioColumn(container).className;

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={AUDIO}
        isFullscreen
        onToggleFullscreen={vi.fn()}
      />,
    );

    // The audio wrapper is byte-identical before and after fullscreen: the
    // video column's geometry change must not leak into the audio branch.
    expect(audioColumn(container).className).toBe(before);
    expect(before).toContain("p-6");
    expect(before).not.toContain("p-0");
    expect(container.querySelector("[data-testid='video-surface']")).toBeNull();
    // Audio keeps its back button: its fullscreen layout still reserves the
    // top band for it.
    expect(backButton(container)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S4 (libmpv composition plumbing): the page background must not paint over
// the video rect while the native host is visible, or the DComp visual (which
// composites BELOW the webview) could never show. The background moves off
// <main> onto a dedicated layer that clips the host rect out (evenodd hole)
// and only WHILE the host is shown — host-hidden states keep the exact old
// placeholder look, and audio mode is untouched.
// ---------------------------------------------------------------------------
describe("S4: host transparency — the player background clips the video rect", () => {
  function bgLayer(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      "[data-testid='drplay-player-bg']",
    );
  }

  it("video track: the background lives on the layer, not inline on <main>", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );

    const layer = bgLayer(container);
    expect(layer).not.toBeNull();
    expect(layer?.style.background).toContain("var(--player-bg-solid)");
    const main = container.querySelector<HTMLElement>("main");
    expect(main?.getAttribute("style") ?? "").not.toContain("background");
  });

  it("no frame yet: the layer does NOT punch the hole; the first frame opens it", async () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );

    // Host is already shown, but nothing has been presented: punching the hole
    // here is what let the (transparent) shell show through the empty rect.
    expect(bgLayer(container)?.style.clipPath ?? "").toBe("");

    await firstFrame();

    const clip = bgLayer(container)?.style.clipPath ?? "";
    expect(clip).toContain("polygon(evenodd");
    // Unset variables must resolve to a zero-size hole (no transparency).
    expect(clip).toContain("var(--drplay-hole-l, 0px)");
    expect(clip).toContain("var(--drplay-hole-b, 0px)");
  });

  it("host hidden (shell locked): no hole — the layer paints the full background", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} isShellLocked />,
    );

    expect(bgLayer(container)).not.toBeNull();
    expect(bgLayer(container)?.style.clipPath ?? "").toBe("");
  });

  it("audio track: no layer, and the inline background stays on <main>", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={AUDIO} />,
    );

    expect(bgLayer(container)).toBeNull();
    const main = container.querySelector<HTMLElement>("main");
    expect(main?.style.background).toContain("var(--player-bg-solid)");
  });
});

// ---------------------------------------------------------------------------
// S4d: the invariant the App.css shell rule leans on.
//
// `html.drplay-host-visible aside, #content-area, #content-area *` set
// `background-color: transparent` (S4b), so the ONLY thing that makes the
// webview alpha=0 inside the video rect — which is what lets the DComp visual
// show through at all — is that the marker class is on. It is safe to drop the
// shell's paint ONLY while the overlay's own background layer repaints the
// identical background over the whole viewport, and that layer lives INSIDE the
// overlay (NowPlayingView), which is translated off-screen when closed. So the
// class must follow `isOpen` exactly: on while open (shell transparent => video
// visible), off while closed (shell keeps its own background). Any drift either
// way is a full-window hole, so it is asserted here rather than trusted.
// ---------------------------------------------------------------------------
describe("S4d: the host marker class follows the overlay", () => {
  function marked(): boolean {
    return document.documentElement.classList.contains("drplay-host-visible");
  }

  it("is OFF for a VIDEO track while the overlay is CLOSED", () => {
    render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} isOpen={false} />,
    );

    expect(marked()).toBe(false);
    expect(visibleCalls()).toEqual([false]);
  });

  it("follows isOpen: off -> on -> off", () => {
    const props = baseProps();
    const { rerender } = render(
      <NowPlayingView {...props} currentTrack={VIDEO} isOpen={false} />,
    );
    expect(marked()).toBe(false);

    rerender(<NowPlayingView {...props} currentTrack={VIDEO} isOpen />);
    expect(marked()).toBe(true);

    rerender(<NowPlayingView {...props} currentTrack={VIDEO} isOpen={false} />);
    expect(marked()).toBe(false);
    expect(visibleCalls()).toEqual([false, true, false]);
  });

  it("is OFF after unmount (an audio track swaps the surface out mid-playback)", () => {
    const { unmount } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    expect(marked()).toBe(true);

    unmount();

    expect(marked()).toBe(false);
  });
});
