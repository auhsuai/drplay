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
  };
});

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
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
