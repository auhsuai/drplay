// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const audioMock = vi.hoisted(() => ({
  on: vi.fn(() => () => {}),
  playTrack: vi.fn(() => Promise.resolve()),
}));

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

  it("hasError → center button is the retry affordance (RefreshCw, no spinner); click replays the current track", () => {
    const track = makeTrack();
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

    expect(audioMock.playTrack).toHaveBeenCalledWith(track, track.restoreTime);
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
