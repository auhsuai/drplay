// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import en from "../../locales/en/translation.json";
import { NowPlayingView } from "./NowPlayingView";
import {
  guardAllowsAutoAdvance,
  noteFormatError,
  resetAdvanceGuard,
} from "../../utils/playerError";

vi.mock("react-i18next", () => {
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string) => resolveKey(key) ?? fallback ?? key,
    }),
  };
});

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
    // The surface renders the shared VolumeSlider, which reads the engine
    // through this same facade.
    getVolume: vi.fn(() => 0.5),
    isMuted: vi.fn(() => false),
    toggleMute: vi.fn(() => false),
    setVolume: vi.fn(),
    // Video tracks render the shared VideoPlayerBar (clock + transport), which
    // reads the engine clock through these.
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    getCurrentTrackId: vi.fn<() => string | null>(() => null),
  };
});

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

// A video track mounts VideoSurface + useVideoFirstFrame, which use these IPC
// modules. Stubbed so the video-rendering tests stay deterministic in jsdom.
const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Controllable stand-in for the shared player store: the view reads
// isDownloading + errorInfo from it, and retryCurrentTrack (P2-12-6) resolves
// the current track through getState().
const storeState = vi.hoisted(() => ({
  isDownloading: false,
  errorInfo: null as { code: string; message: string } | null,
  currentTrack: null as {
    id: string;
    title: string;
    artist: string;
    streamUrl: string;
    restoreTime?: number;
  } | null,
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

function makeTrack(): Track {
  return {
    id: "track-1",
    title: "Song",
    artist: "Artist",
    streamUrl: "/drive-stream/track-1",
  };
}

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

function tripAdvanceGuard(): void {
  resetAdvanceGuard();
  const now = Date.now();
  noteFormatError(now);
  noteFormatError(now);
  noteFormatError(now);
}

afterEach(() => {
  cleanup();
});

describe("NowPlayingView back-button accessible name (P2-12-3)", () => {
  it("empty state → nút back có accessible name common.close", () => {
    render(<NowPlayingView {...baseProps()} />);

    expect(screen.getByRole("button", { name: en.common.close })).toBeTruthy();
  });

  it("track state → nút back có accessible name common.close", () => {
    render(<NowPlayingView {...baseProps()} currentTrack={makeTrack()} />);

    expect(screen.getByRole("button", { name: en.common.close })).toBeTruthy();
  });
});

describe("NowPlayingView collapse button on VIDEO + fullscreen chrome", () => {
  const VIDEO_TRACK: Track = { ...makeTrack(), originalName: "movie.mkv" };

  function closeButton(): HTMLElement {
    return screen.getByRole("button", { name: en.common.close });
  }

  function closeWrapper(): HTMLElement {
    const wrapper = closeButton().parentElement;
    if (!wrapper) throw new Error("close wrapper not rendered");
    return wrapper;
  }

  it("a video track renders the collapse button; clicking it only calls onBack", () => {
    const props = baseProps();
    render(<NowPlayingView {...props} currentTrack={VIDEO_TRACK} />);

    const button = closeButton();
    // The wrapper owns the position + chrome classes; the button is its direct
    // child so the fade/pointer-events contract is testable on the wrapper.
    expect(button.parentElement?.className).toContain("absolute");
    fireEvent.click(button);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it("fullscreen with hidden chrome fades the wrapper out and disables pointer events", () => {
    render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO_TRACK}
        isFullscreen
        chromeVisible={false}
      />,
    );

    const wrapper = closeWrapper();
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.className).toContain("pointer-events-none");
    expect(
      wrapper.className.split(" ").filter((c) => c.startsWith("opacity-")),
    ).toEqual(["opacity-0"]);
  });

  it("fullscreen with visible chrome paints the wrapper and keeps it interactive", () => {
    render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO_TRACK}
        isFullscreen
      />,
    );

    const wrapper = closeWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.className).not.toContain("pointer-events-none");
    expect(
      wrapper.className.split(" ").filter((c) => c.startsWith("opacity-")),
    ).toEqual(["opacity-100"]);
  });

  it("windowed ignores chromeVisible (the bar is always painted)", () => {
    render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO_TRACK}
        chromeVisible={false}
      />,
    );

    const wrapper = closeWrapper();
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.className).not.toContain("pointer-events-none");
  });
});

describe("NowPlayingView full-screen error surface (P2-12-6)", () => {
  afterEach(() => {
    storeState.errorInfo = null;
    storeState.currentTrack = null;
    storeState.isDownloading = false;
    audioMock.playTrack.mockClear();
    cleanup();
  });

  it("renders the error banner INSIDE the overlay (same source as PlayerBar, not hidden behind z-[9999])", () => {
    storeState.errorInfo = {
      code: "network_interrupted",
      message: "Mạng không ổn định, đang thử lại...",
    };
    render(<NowPlayingView {...baseProps()} currentTrack={makeTrack()} />);

    expect(screen.getByText(en.player.network_interrupted)).toBeTruthy();
  });

  it("hasError → center button is the retry affordance (RefreshCw, no spinner); click replays the current track WITHOUT the stale restore position (F8-8)", () => {
    const track = { ...makeTrack(), restoreTime: 12 };
    storeState.errorInfo = {
      code: "format_error",
      message: "File lỗi định dạng, đang bỏ qua...",
    };
    storeState.currentTrack = track;
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={track} />,
    );

    expect(container.querySelector(".lucide-refresh-cw")).not.toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();

    const center = container.querySelector<HTMLButtonElement>(
      "button.bg-brand-primary",
    );
    if (!center) throw new Error("center button not found");
    fireEvent.click(center);

    // Retry is not a restore: it never re-reads Track.restoreTime (one-shot
    // resume hint consumed by the first play — F7-6/F8-8).
    expect(audioMock.playTrack).toHaveBeenCalledWith(track);
  });

  it("no error → no banner and the center button stays Play", () => {
    render(<NowPlayingView {...baseProps()} currentTrack={makeTrack()} />);

    expect(screen.queryByText(en.player.network_interrupted)).toBeNull();
    expect(screen.queryByText(en.player.format_error)).toBeNull();
  });
});

describe("NowPlayingView storm guard parity (F7-7)", () => {
  afterEach(() => {
    resetAdvanceGuard();
    cleanup();
  });

  it("nút next/prev reset advance guard như PlayerBar (cùng hành vi manual)", () => {
    const props = baseProps();
    render(<NowPlayingView {...props} currentTrack={makeTrack()} />);

    tripAdvanceGuard();
    expect(guardAllowsAutoAdvance(Date.now())).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: en.player.next }));
    expect(props.onNextTrack).toHaveBeenCalledTimes(1);
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);

    tripAdvanceGuard();
    expect(guardAllowsAutoAdvance(Date.now())).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: en.player.prev }));
    expect(props.onPrevTrack).toHaveBeenCalledTimes(1);
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);
  });

  it("nút play/pause (không có lỗi) reset advance guard", () => {
    const props = baseProps();
    render(<NowPlayingView {...props} currentTrack={makeTrack()} />);

    tripAdvanceGuard();
    expect(guardAllowsAutoAdvance(Date.now())).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: en.player.play }));
    expect(props.onTogglePlay).toHaveBeenCalledTimes(1);
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);
  });
});

// The full-screen player surface is where the controls actually live (the
// PlayerBar collapses to h-0 behind it), so a missing control here is a
// missing control during playback — not a cosmetic gap.
describe("NowPlayingView transport completeness in the full-screen surface", () => {
  afterEach(() => {
    cleanup();
  });

  it("carries volume next to the transport row (F3: the PlayerBar is off-screen here)", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={makeTrack()} />,
    );
    // The shared control, not a second one: same testid as the PlayerBar's.
    const rail = container.querySelector<HTMLElement>(
      "[data-testid='volume-bar']",
    );
    expect(rail).not.toBeNull();
    // Reachable here — the PlayerBar hides its own rail below the xl breakpoint.
    expect(rail?.className).not.toContain("hidden");
  });

  it("uses the shared 125px rail and 8px icon gap on the audio surface", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={makeTrack()} />,
    );
    const rail = container.querySelector<HTMLElement>(
      "[data-testid='volume-bar']",
    );
    const iconGroup = rail?.parentElement as HTMLElement;
    const outer = iconGroup.parentElement as HTMLElement;

    expect(rail?.className).toContain("w-[125px]");
    expect(rail?.className).toContain("h-1.5");
    expect(rail?.className).toContain("rounded-full");
    expect(rail?.className).not.toContain("hidden");
    expect(rail?.className).not.toContain("xl:flex");
    expect(iconGroup.className.split(" ")).toContain("gap-2");
    expect(outer.className.split(" ")).toContain("gap-4");
  });

  it("still owns prev / play / next / play-mode (unchanged transport surface)", () => {
    render(<NowPlayingView {...baseProps()} currentTrack={makeTrack()} />);

    expect(screen.getByRole("button", { name: en.player.prev })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.player.play })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.player.next })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: en.player.play_mode }),
    ).toBeTruthy();
  });
});

describe("NowPlayingView buffering identity (R2.1 — stale-track misattribution)", () => {
  afterEach(() => {
    storeState.currentTrack = null;
    cleanup();
  });

  it("buffering of another track never flips the spinner; the current track's event does", () => {
    storeState.currentTrack = makeTrack();
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={makeTrack()}
        isPlaying={true}
      />,
    );

    act(() => {
      audioMock._emit("buffering", {
        isBuffering: true,
        trackId: "stale-track",
        attempt: 1,
      });
    });
    expect(container.querySelector(".animate-spin")).toBeNull();

    act(() => {
      audioMock._emit("buffering", {
        isBuffering: true,
        trackId: "track-1",
        attempt: 3,
      });
    });
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});

// U4: the AUDIO branch must not depend on the video frame signal. The engine's
// buffering signal is the only spinner source it needs — an audio track has no
// frame to wait for, so the view must not subscribe to (or pull) it.
describe("NowPlayingView audio branch never waits for a video frame (U4)", () => {
  afterEach(() => {
    storeState.currentTrack = null;
    storeState.isDownloading = false;
    cleanup();
  });

  it("the audio controls spin on the engine's buffering alone (no frame involved)", () => {
    storeState.currentTrack = makeTrack();
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={makeTrack()}
        isPlaying={false}
      />,
    );

    act(() => {
      audioMock._emit("buffering", {
        isBuffering: true,
        trackId: "track-1",
        attempt: 1,
      });
    });

    expect(container.querySelector(".animate-spin")).not.toBeNull();
    // No video surface at all: the audio branch never asks for a frame.
    expect(container.querySelector("[data-testid='video-surface']")).toBeNull();
  });

  it("an empty player shows no spinner and no surface", () => {
    const { container } = render(<NowPlayingView {...baseProps()} />);

    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector("[data-testid='video-surface']")).toBeNull();
  });
});
