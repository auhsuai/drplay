// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { Track } from "../../types";
import { PlayerBar } from "./PlayerBar";
import en from "../../locales/en/translation.json";
import type { PlayerBarProps } from "./types";
import { usePlayerStore } from "../../store/playerStore";
import { getTrackMetadata } from "../../utils/metadata";
import { useAuthStore } from "../../store/authStore";
import * as errorLog from "../../utils/errorLog";
import { FAVORITES_UPDATED_EVENT } from "../../utils/favorites";
import { DEBUG_EVENTS } from "../debug/debugEvents";

vi.mock("react-i18next", () => {
  // Resolve keys against the real en resources so assertions read the
  // shipped copy instead of hard-coded fallbacks.
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

vi.mock("lucide-react", () => {
  const icons = [
    "CloudOff",
    "FileWarning",
    "WifiOff",
    "Play",
    "Pause",
    "SkipBack",
    "SkipForward",
    "Volume2",
    "Volume1",
    "Volume",
    "VolumeX",
    "LoaderCircle",
    "Music",
    "Shuffle",
    "Repeat",
    "Repeat1",
    "Maximize2",
    "RefreshCw",
    "Heart",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const { isFavorite, addFavorite, removeFavorite } = vi.hoisted(() => ({
  isFavorite: vi.fn<(trackId: string) => Promise<boolean>>(),
  addFavorite: vi.fn<(track: Track) => Promise<void>>(),
  removeFavorite: vi.fn<(trackId: string) => Promise<void>>(),
}));

vi.mock("../../utils/favorites", () => ({
  isFavorite,
  addFavorite,
  removeFavorite,
  // Mirrors the constant from favorites.ts so the test-side dispatch uses
  // the same event name the component under test listens for.
  FAVORITES_UPDATED_EVENT: "favorites-updated",
}));

vi.mock("../components/MoreMenu", () => ({ MoreMenu: () => null }));

// TrackInfo fetches cover metadata per track; the real module pulls heavy
// deps (music-metadata, IndexedDB) not needed here. V_PLACEHOLDER /
// UNKNOWN_ARTIST are mirrored so TrackInfo's real-entry guard works in tests.
vi.mock("../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
  V_PLACEHOLDER: 9,
  UNKNOWN_ARTIST: "Unknown Artist",
}));

// Task 12: on mobile the bar shows title only — no cover, no artist, and the
// TrackInfo metadata fetch is skipped. Hoisted mock toggles the platform
// flag; the getter keeps the named-export binding live.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

const mockedGetTrackMetadata = vi.mocked(getTrackMetadata);

const { fakeController } = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  const fakeController = {
    on: vi.fn(),
    getDuration: vi.fn(() => 0),
    getCurrentTime: vi.fn(() => 0),
    getBuffered: vi.fn(),
    seek: vi.fn(),
    playTrack: vi.fn(),
    pause: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    _handlers: {} as Record<string, Handler[]>,
    _emit(event: string, payload?: unknown) {
      for (const h of fakeController._handlers[event] ?? []) h(payload);
    },
  };
  return { fakeController };
});

function installFakeOn() {
  fakeController.on.mockImplementation(
    (event: string, handler: (payload: unknown) => void) => {
      (fakeController._handlers[event] ??= []).push(handler);
      return () => {
        fakeController._handlers[event] = (
          fakeController._handlers[event] ?? []
        ).filter((h) => h !== handler);
      };
    },
  );
}

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => fakeController },
}));

// Task 12: the mobile gate makes getPlaybackEngine() resolve to the REAL
// native engine (which would call @tauri-apps/api invoke in jsdom) — route it
// to the same fake controller so the mobile branch stays hermetic.
vi.mock("../../lib/nativeAudioBridge", () => ({
  getPlaybackEngine: () => fakeController,
}));

function setBuffered(
  ranges: Array<[number, number]>,
  duration = 1000,
  currentTime = 10,
) {
  fakeController.getBuffered.mockReturnValue({
    duration,
    currentTime,
    buffered: {
      length: ranges.length,
      start: (i: number) => ranges[i]?.[0] ?? 0,
      end: (i: number) => ranges[i]?.[1] ?? 0,
    } as TimeRanges,
  });
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "Song",
    artist: "Artist",
    streamUrl: "/drive-stream/track-1",
    ...overrides,
  };
}

function renderPlayer(overrides: Partial<PlayerBarProps> = {}) {
  return render(
    <PlayerBar
      currentTrack={makeTrack()}
      isPlaying={false}
      onTogglePlay={vi.fn()}
      onNextTrack={vi.fn()}
      onPrevTrack={vi.fn()}
      playMode="normal"
      onTogglePlayMode={vi.fn()}
      onExpandNowPlaying={vi.fn()}
      {...overrides}
    />,
  );
}

// Mirrors the real App wiring (App.tsx passes store.currentTrack down as the
// prop): subscribing the PlayerBar to the store lets a store-side metadata
// update flow through to the rendered title/artist text.
function StoreWiredPlayerBar(overrides: Partial<PlayerBarProps> = {}) {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  return (
    <PlayerBar
      currentTrack={currentTrack}
      isPlaying={false}
      onTogglePlay={vi.fn()}
      onNextTrack={vi.fn()}
      onPrevTrack={vi.fn()}
      playMode="normal"
      onTogglePlayMode={vi.fn()}
      onExpandNowPlaying={vi.fn()}
      {...overrides}
    />
  );
}
beforeEach(() => {
  fakeController.on.mockClear();
  fakeController.getBuffered.mockClear();
  // Reset both duration and currentTime to the no-metadata default so a
  // mockReturnValue from an earlier describe (seek tests) never leaks into
  // later ones (tooltip/pause tests rely on duration 0).
  fakeController.getDuration.mockReset();
  fakeController.getDuration.mockImplementation(() => 0);
  fakeController.getCurrentTime.mockReset();
  fakeController.getCurrentTime.mockImplementation(() => 0);
  installFakeOn();
  setBuffered([]);
  fakeController._handlers = {};
  isFavorite.mockClear();
  addFavorite.mockClear();
  removeFavorite.mockClear();
  isFavorite.mockResolvedValue(false);
  addFavorite.mockResolvedValue(undefined);
  removeFavorite.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  fakeController._handlers = {};
});

describe("PlayerBar buffer bar", () => {
  it("BUG regression: renders audio.buffered segments in the buffer bar when AudioController emits progress", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    // The segment spans the WHOLE range [0,300] (no left clip at the playhead):
    // the blue fill drawn above it covers the played part. Clipping at the
    // playhead instead would put a second round cap flush against the fill's
    // round cap — the two semicircles touch only at a point and open a
    // lens-shaped gap (rail showing through) above and below the seam.
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("30%");
    // Segment carries a NEGATIVE head: the left edge is flat (no rounded-l
    // cap) so it cannot butt a second convex cap against the fill's round cap
    // at the playhead (two semicircles touching at a point open a lens gap of
    // bare rail); the right end keeps only a small 2px corner (rounded-r-sm)
    // — a big round "dot" on a mid-track buffer end would float on the rail
    // instead of reading as a continuous buffer run. When the range starts at
    // 0 the container's overflow-hidden rounded-full clip rounds the flat
    // left edge to match the rail.
    expect(seg.className).toContain("rounded-r-sm");
    expect(seg.className).not.toContain("rounded-l-full");
    expect(seg.className).not.toContain("rounded-full");
  });

  it("BUG regression: timeupdate re-renders the buffer bar from audio.buffered (progress race)", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 10, duration: 1000 });
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    // Full-range segment: [0,300] spans the playhead (10) — the blue fill
    // covers [0,10] above it, so the visible buffer starts right at the fill.
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("30%");
  });

  it("BUG regression: buffer segment spans its full range under the fill — no lens gap at the playhead seam", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");

    // Raw media clock reads 60s (getBuffered is unthrottled) while the UI
    // playhead — the throttled timeupdate the blue fill is drawn from — shows
    // 50s. The buffered range [0,100] must render from its OWN start (0%), NOT
    // clipped at the playhead (50%): clipping would put the segment's round
    // head flush against the fill's round cap (two semicircles touching at a
    // point -> lens gap above/below the seam). The fill, drawn above the
    // buffer layer, covers [0,50].
    setBuffered([[0, 100]], 100, 60);
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 50, duration: 100 });
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("100%");
  });

  it("BUG regression: range starting at the UI playhead renders fully (drop filters use the playhead, not the raw clock)", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");

    // Raw media clock reads 60s (getBuffered is unthrottled) while the UI
    // playhead — the throttled timeupdate the blue fill is drawn from — shows
    // 50s. The range [50,100] starts exactly at the playhead, so it must NOT
    // be dropped as "ahead of the playhead" (start > currentTime). Its head is
    // NEGATIVE: pulled back 2% (to 48%) so the flat left edge hides under the
    // fill's round right cap — a single convex cap at the seam, no lens gap.
    setBuffered([[50, 100]], 100, 60);
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 50, duration: 100 });
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    expect(seg.style.left).toBe("48%");
    expect(seg.style.width).toBe("52%");
  });

  it("BUG regression: buffer container is pinned full-width and transparent (segment children own the background)", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");

    // Container must be pinned to the full progress-bar track (inset-0 / w-full
    // / right-0) — never a shrink-to-fit `absolute left-0` box whose width
    // computes to 0 (CSS2.1 §10.3.7), collapsing the child % segments.
    expect(buffer.className).toMatch(/\b(inset-0|w-full)\b|\bright-0\b/);
    // Container must be transparent — the buffered segment children created by
    // updateBufferBar() (bg-gray-400) are the visible part.
    expect(buffer.className).not.toMatch(/\bbg-/);
  });

  it("BUG regression: forward seek shows only the future buffered segment (pre-seek past range dropped)", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");

    setBuffered(
      [
        [0, 30],
        [500, 510],
      ],
      1000,
      505,
    );
    // Move the UI playhead to the seek target (the seek's timeupdate precedes
    // the buffer redraw in the real flow) so the drop filters use the position
    // the fill shows, not the raw clock.
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 505, duration: 1000 });
    });
    act(() => {
      fakeController._emit("progress");
    });

    // Pre-seek [0,30] ends before currentTime=505 -> dropped entirely; [500,510]
    // spans the playhead -> rendered with its head pulled back 2% (to 48.5%)
    // under the fill's round cap; the fill covers [0,505] above it, so only
    // [505,510] is visible.
    expect(buffer.childElementCount).toBe(1);
    expect((buffer.children[0] as HTMLElement).style.left).toBe("48.5%");
    expect((buffer.children[0] as HTMLElement).style.width).toBe("2.5%");
  });

  it("BUG regression: a fully-past buffered range is dropped while a range straddling the playhead renders from its range start", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");

    setBuffered(
      [
        [0, 100],
        [200, 300],
      ],
      1000,
      250,
    );
    // Move the UI playhead to the seek target (the seek's timeupdate precedes
    // the buffer redraw in the real flow) so the drop filters use the position
    // the fill shows, not the raw clock.
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 250, duration: 1000 });
    });
    act(() => {
      fakeController._emit("progress");
    });

    // [0,100] ends before currentTime=250 -> dropped; [200,300] straddles the
    // playhead -> rendered from its own start (20% of duration 1000); the fill
    // covers [0,250] above it, so only [250,300] is visible.
    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    expect(seg.style.left).toBe("20%");
    expect(seg.style.width).toBe("10%");
  });

  it("clears the buffer bar when switching to a new track", () => {
    const { rerender } = renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });
    expect(buffer.childElementCount).toBe(1);

    rerender(
      <PlayerBar
        currentTrack={makeTrack({ id: "track-2" })}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onExpandNowPlaying={vi.fn()}
      />,
    );
    expect(buffer.childElementCount).toBe(0);
  });

  it("unsubscribes the progress handler on unmount (no listener leak)", () => {
    const { unmount } = renderPlayer();
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);

    unmount();

    expect(fakeController._handlers["progress"] ?? []).toHaveLength(0);
  });
});

describe("PlayerBar seek-drag", () => {
  beforeEach(() => {
    fakeController.seek.mockClear();
  });

  function dragBar() {
    const bar = screen.getByTestId("buffer-fill").parentElement as HTMLElement;
    const rect = {
      left: 0,
      right: 200,
      top: 0,
      bottom: 10,
      width: 200,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect;
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect);
    return bar;
  }

  it("BUG regression: updates the time text live while dragging (not only on commit)", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });

    const bar = dragBar();
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    expect(screen.getByText("1:00")).toBeTruthy();

    act(() => {
      fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    });
    expect(screen.getByText("2:00")).toBeTruthy();

    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
  });

  it("BUG regression: pointercancel commits the seek and removes all window drag listeners (no leak)", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });

    const bar = dragBar();
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    expect(fakeController.seek).not.toHaveBeenCalled();

    act(() => {
      fireEvent.pointerCancel(window, { clientX: 100, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);

    // Listeners removed — a late pointerup must not seek again.
    act(() => {
      fireEvent.pointerUp(window, { clientX: 150, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
  });
});

describe("PlayerBar seek redraws buffer bar immediately (no empty blink)", () => {
  beforeEach(() => {
    fakeController.seek.mockClear();
    // seekRelative guards on duration <= 0 (metadata not loaded) — these
    // seek tests need a loaded duration or the seek is a deliberate no-op.
    fakeController.getDuration.mockReturnValue(240);
  });

  it("BUG regression: ArrowLeft seek redraws the buffer bar synchronously (no empty-blink, stale ranges filtered)", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });
    expect(buffer.childElementCount).toBe(1);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowLeft" });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    // Immediate redraw at seek time — the bar never flashes empty.
    expect(buffer.childElementCount).toBe(1);
  });

  it("BUG regression: ArrowRight seek redraws the buffer bar synchronously (no empty-blink, stale ranges filtered)", () => {
    renderPlayer();
    const buffer = screen.getByTestId("buffer-fill");

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });
    expect(buffer.childElementCount).toBe(1);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    // Immediate redraw at seek time — the bar never flashes empty.
    expect(buffer.childElementCount).toBe(1);
  });

  it("BUG regression: drag commit (pointerup) redraws the buffer bar synchronously after seek", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });
    const buffer = screen.getByTestId("buffer-fill");

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });
    expect(buffer.childElementCount).toBe(1);

    const bar = buffer.parentElement as HTMLElement;
    const rect = {
      left: 0,
      right: 200,
      top: 0,
      bottom: 10,
      width: 200,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect;
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect);
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
    // Immediate redraw at seek time — the bar never flashes empty.
    expect(buffer.childElementCount).toBe(1);
  });
});

describe("PlayerBar error banner recovery", () => {
  const NETWORK_ERROR_TEXT = en.player.network_interrupted;

  it("BUG regression: shows the error banner when AudioController emits error", () => {
    renderPlayer();
    expect(screen.queryByText(NETWORK_ERROR_TEXT)).toBeNull();

    act(() => {
      fakeController._emit("error", {
        message: "Mạng không ổn định, đang thử lại...",
        code: "network_interrupted",
      });
    });

    expect(screen.getByText(NETWORK_ERROR_TEXT)).toBeTruthy();
  });

  it("BUG regression: clears the error banner when playback recovers (play event)", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("error", {
        message: "Mạng không ổn định, đang thử lại...",
        code: "network_interrupted",
      });
    });
    expect(screen.getByText(NETWORK_ERROR_TEXT)).toBeTruthy();

    act(() => {
      fakeController._emit("play");
    });

    expect(screen.queryByText(NETWORK_ERROR_TEXT)).toBeNull();
  });

  it("unsubscribes the play handler on unmount (no listener leak)", () => {
    const { unmount } = renderPlayer();
    expect(fakeController._handlers["play"] ?? []).toHaveLength(1);

    unmount();

    expect(fakeController._handlers["play"] ?? []).toHaveLength(0);
  });
});

describe("PlayerBar debug player-error trigger (DEV only)", () => {
  const NETWORK_ERROR_TEXT = en.player.network_interrupted;

  it("shows the error banner when PLAYER_ERROR fires with a mapped code", () => {
    renderPlayer();
    expect(screen.queryByText(NETWORK_ERROR_TEXT)).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(DEBUG_EVENTS.PLAYER_ERROR, {
          detail: {
            code: "network_interrupted",
            message: "Mạng không ổn định, đang thử lại...",
          },
        }),
      );
    });

    expect(screen.getByText(NETWORK_ERROR_TEXT)).toBeTruthy();
  });

  it("falls back to the raw message for an unmapped code", () => {
    renderPlayer();
    const rawMessage = "some unexpected failure";

    act(() => {
      window.dispatchEvent(
        new CustomEvent(DEBUG_EVENTS.PLAYER_ERROR, {
          detail: { code: "unknown_code", message: rawMessage },
        }),
      );
    });

    expect(screen.getByText(rawMessage)).toBeTruthy();
  });

  it("format_error renders the banner WITHOUT marking the track broken or tripping the storm guard", () => {
    usePlayerStore.setState({ currentTrack: makeTrack(), brokenTrackIds: [] });
    const onNext = vi.fn();
    renderPlayer({ onNextTrack: onNext });

    const dispatchFormatError = () => {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(DEBUG_EVENTS.PLAYER_ERROR, {
            detail: {
              code: "format_error",
              message: "File lỗi định dạng, đang bỏ qua...",
            },
          }),
        );
      });
    };

    dispatchFormatError();
    expect(screen.getByText(en.player.format_error)).toBeTruthy();
    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");

    // 3 format_error dispatches through the debug channel — the storm
    // threshold — must NOT block auto-advance: the debug listener only sets
    // errorInfo, it never runs the storm-guard refs of audio.on("error").
    dispatchFormatError();
    dispatchFormatError();
    expect(screen.queryByText(en.player.advance_stopped)).toBeNull();

    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");
  });

  it("does not crash when PLAYER_ERROR fires after unmount (listener cleaned up)", () => {
    const { unmount } = renderPlayer();
    unmount();

    expect(() => {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(DEBUG_EVENTS.PLAYER_ERROR, {
            detail: { code: "format_error", message: "x" },
          }),
        );
      });
    }).not.toThrow();
  });
});

describe("PlayerBar broken-track marking (Task D — repeat-all loop guard)", () => {
  beforeEach(() => {
    usePlayerStore.setState({ currentTrack: makeTrack(), brokenTrackIds: [] });
  });

  afterEach(() => {
    usePlayerStore.setState({ currentTrack: null, brokenTrackIds: [] });
  });

  it("Task D regression: error format_error → đánh dấu track hiện tại broken (auto-advance sẽ skip)", () => {
    renderPlayer();
    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");

    act(() => {
      fakeController._emit("error", {
        message: "File lỗi định dạng, đang bỏ qua...",
        code: "format_error",
      });
    });

    expect(usePlayerStore.getState().brokenTrackIds).toContain("track-1");
  });

  it("Task D: error network_interrupted (retryable) → KHÔNG đánh dấu broken", () => {
    renderPlayer();

    act(() => {
      fakeController._emit("error", {
        message: "Mạng không ổn định, đang thử lại...",
        code: "network_interrupted",
      });
    });

    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");
  });

  it("Task D: ended tự nhiên (không kèm error) → KHÔNG đánh dấu broken (auto-advance như cũ)", () => {
    renderPlayer();

    act(() => {
      fakeController._emit("ended");
    });

    expect(usePlayerStore.getState().brokenTrackIds).not.toContain("track-1");
  });

  it("Task D: không có currentTrack → error format_error không crash, không đánh dấu", () => {
    usePlayerStore.setState({ currentTrack: null });
    renderPlayer({ currentTrack: null });

    expect(() => {
      act(() => {
        fakeController._emit("error", {
          message: "File lỗi định dạng, đang bỏ qua...",
          code: "format_error",
        });
      });
    }).not.toThrow();
  });
});

describe("PlayerBar auto-advance storm guard (Fix I — queue cháy hết im lặng)", () => {
  const FORMAT_ERROR = {
    message: "File lỗi định dạng, đang bỏ qua...",
    code: "format_error",
  };
  const NETWORK_ERROR = {
    message: "Mạng không ổn định, đang thử lại...",
    code: "network_interrupted",
  };

  function stormBlock(onNext: ReturnType<typeof vi.fn>) {
    // 3 lần error format_error + ended liên tiếp → chạm ngưỡng storm
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(2);
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    expect(screen.getByText(en.player.advance_stopped)).toBeTruthy();
    act(() => {
      fakeController._emit("ended");
    });
  }

  beforeEach(() => {
    usePlayerStore.setState({
      currentTrack: makeTrack(),
      isPlaying: true,
      brokenTrackIds: [],
    });
  });

  afterEach(() => {
    usePlayerStore.setState({
      currentTrack: null,
      isPlaying: false,
      brokenTrackIds: [],
    });
    vi.useRealTimers();
  });

  it("Fix I regression: 3 format_error liên tiếp trong window → ended thứ 3 KHÔNG gọi onNextTrack, dừng phát + hiện thông báo storm", () => {
    const onNext = vi.fn();
    renderPlayer({ onNextTrack: onNext });

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(2);

    // Lỗi thứ 3 chạm ngưỡng STORM_ERRORS → thông báo rõ ràng thay vì toast
    // format_error bị reset theo track (root cause: user không thấy gì).
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    expect(screen.getByText(en.player.advance_stopped)).toBeTruthy();

    // Ended kèm theo KHÔNG được auto-next — queue dừng đốt, playback dừng.
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(2);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("Fix I: 2 lỗi rồi window trôi (15s) → lỗi sau mở cửa sổ mới, ended vẫn next (không chặn nhầm)", () => {
    vi.useFakeTimers();
    const onNext = vi.fn();
    renderPlayer({ onNextTrack: onNext });

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    // Window 15s đã trôi hẳn so với lỗi đầu → lỗi tiếp theo bắt đầu cửa sổ mới
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(en.player.advance_stopped)).toBeNull();
  });

  it("Fix I: 'play' event (phát thành công) reset counter → 2 lỗi kế tiếp vẫn next, lỗi thứ 3 kể từ reset mới chặn", () => {
    const onNext = vi.fn();
    renderPlayer({ onNextTrack: onNext });

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(2);

    // Phát thành công → guard reset (nếu không reset, lỗi kế tiếp đã chặn)
    act(() => {
      fakeController._emit("play");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(4);

    // Lỗi thứ 3 kể từ play → chặn như storm mới
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    expect(screen.getByText(en.player.advance_stopped)).toBeTruthy();
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(4);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("Fix I: manual next (phím n) reset guard → auto-advance hoạt động lại", () => {
    const onNext = vi.fn();
    renderPlayer({ onNextTrack: onNext });

    stormBlock(onNext);
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    // Manual next = user chủ động → guard reset, không còn bị giữ
    act(() => {
      fireEvent.keyDown(window, { key: "n" });
    });
    expect(onNext).toHaveBeenCalledTimes(3);

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(4);
  });

  it("Fix I: manual prev (phím p) reset guard", () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    renderPlayer({ onNextTrack: onNext, onPrevTrack: onPrev });

    stormBlock(onNext);

    act(() => {
      fireEvent.keyDown(window, { key: "p" });
    });
    expect(onPrev).toHaveBeenCalledTimes(1);

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(3);
  });

  it("Fix I: manual toggle play (phím cách) reset guard", () => {
    const onNext = vi.fn();
    const onTogglePlay = vi.fn();
    renderPlayer({ onNextTrack: onNext, onTogglePlay });

    stormBlock(onNext);

    act(() => {
      fireEvent.keyDown(window, { key: " " });
    });
    expect(onTogglePlay).toHaveBeenCalledTimes(1);

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(3);
  });

  it("Fix I: manual retry (nút phát giữa khi đang có lỗi) reset guard", () => {
    const onNext = vi.fn();
    renderPlayer({ onNextTrack: onNext });

    stormBlock(onNext);

    // Nút trung tâm khi hasError → onRetry (replay restore time)
    const centerButton = screen.getAllByRole("button")[3] as HTMLElement;
    fireEvent.click(centerButton);
    expect(fakeController.playTrack).toHaveBeenCalledTimes(1);

    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    expect(onNext).toHaveBeenCalledTimes(3);
  });

  it("Fix I: network_interrupted (retryable) KHÔNG đếm vào storm counter", () => {
    const onNext = vi.fn();
    renderPlayer({ onNextTrack: onNext });

    act(() => {
      fakeController._emit("error", NETWORK_ERROR);
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("error", FORMAT_ERROR);
    });
    act(() => {
      fakeController._emit("ended");
    });

    // Vẫn chặn sau đúng 3 format_error (network không cộng dồn)
    expect(onNext).toHaveBeenCalledTimes(2);
    expect(screen.getByText(en.player.advance_stopped)).toBeTruthy();
  });

  it("Fix I: ended phát hết bài tự nhiên (không có format_error trước) → luôn next, không bao giờ chặn", () => {
    const onNext = vi.fn();
    renderPlayer({ onNextTrack: onNext });

    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("ended");
    });
    act(() => {
      fakeController._emit("ended");
    });

    expect(onNext).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(en.player.advance_stopped)).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });
});

describe("PlayerBar favorite (heart) button", () => {
  it("checks favorite status for the current track and renders the heart button (not liked)", async () => {
    renderPlayer();
    const btn = await screen.findByRole("button", { name: "Add to favorites" });
    expect(btn).toBeTruthy();
    expect(isFavorite).toHaveBeenCalledWith("track-1");
  });

  it("shows the liked state (remove aria-label + filled class) when isFavorite resolves true", async () => {
    isFavorite.mockResolvedValue(true);
    renderPlayer();
    const btn = await screen.findByRole("button", {
      name: "Remove from favorites",
    });
    expect(btn.className).toContain("text-brand-primary");
  });

  it("calls addFavorite and flips to liked on click when not liked", async () => {
    renderPlayer();
    const btn = await screen.findByRole("button", { name: "Add to favorites" });
    fireEvent.click(btn);
    await screen.findByRole("button", { name: "Remove from favorites" });
    expect(addFavorite).toHaveBeenCalledTimes(1);
    expect(addFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ id: "track-1" }),
    );
    expect(removeFavorite).not.toHaveBeenCalled();
  });

  it("calls removeFavorite on click when already liked", async () => {
    isFavorite.mockResolvedValue(true);
    renderPlayer();
    const btn = await screen.findByRole("button", {
      name: "Remove from favorites",
    });
    fireEvent.click(btn);
    await screen.findByRole("button", { name: "Add to favorites" });
    expect(removeFavorite).toHaveBeenCalledTimes(1);
    expect(removeFavorite).toHaveBeenCalledWith("track-1");
    expect(addFavorite).not.toHaveBeenCalled();
  });

  it("re-checks favorite status when the track id changes", async () => {
    const { rerender } = renderPlayer();
    await screen.findByRole("button", { name: "Add to favorites" });
    isFavorite.mockClear();

    rerender(
      <PlayerBar
        currentTrack={makeTrack({ id: "track-2" })}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onExpandNowPlaying={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Add to favorites" });
    expect(isFavorite).toHaveBeenCalledWith("track-2");
  });

  it("re-checks the current track when favorites-updated fires elsewhere (no stale heart)", async () => {
    renderPlayer();
    await screen.findByRole("button", { name: "Add to favorites" });
    isFavorite.mockClear();
    isFavorite.mockResolvedValue(true);

    act(() => {
      window.dispatchEvent(new CustomEvent(FAVORITES_UPDATED_EVENT));
    });

    expect(isFavorite).toHaveBeenCalledWith("track-1");
    await screen.findByRole("button", { name: "Remove from favorites" });
  });

  it("does not crash when favorites-updated fires with no current track", async () => {
    const { rerender } = renderPlayer();
    await screen.findByRole("button", { name: "Add to favorites" });
    isFavorite.mockClear();

    rerender(
      <PlayerBar
        currentTrack={null}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onExpandNowPlaying={vi.fn()}
      />,
    );

    expect(() => {
      act(() => {
        window.dispatchEvent(new CustomEvent(FAVORITES_UPDATED_EVENT));
      });
    }).not.toThrow();
    expect(isFavorite).not.toHaveBeenCalled();
  });

  it("ignores a second click while the first toggle is still in flight (no duplicate add)", async () => {
    let resolveAdd: (() => void) | undefined;
    addFavorite.mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          resolveAdd = res;
        }),
    );
    renderPlayer();
    const btn = await screen.findByRole("button", { name: "Add to favorites" });

    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(addFavorite).toHaveBeenCalledTimes(1);
    act(() => {
      resolveAdd?.();
    });
    await screen.findByRole("button", { name: "Remove from favorites" });
  });

  it("resets the toggle guard after completion so the next click can remove", async () => {
    renderPlayer();
    const btn = await screen.findByRole("button", { name: "Add to favorites" });
    fireEvent.click(btn);
    await screen.findByRole("button", { name: "Remove from favorites" });
    expect(addFavorite).toHaveBeenCalledTimes(1);

    const removeBtn = screen.getByRole("button", {
      name: "Remove from favorites",
    });
    fireEvent.click(removeBtn);
    await screen.findByRole("button", { name: "Add to favorites" });
    expect(removeFavorite).toHaveBeenCalledTimes(1);
    expect(removeFavorite).toHaveBeenCalledWith("track-1");
  });
});

describe("PlayerBar seekbar hover preview (tooltip + buffer preview + thumb idle)", () => {
  const BAR_WIDTH = 200;

  function mockBarRect() {
    const bar = screen.getByTestId("buffer-fill").parentElement as HTMLElement;
    const rect = {
      left: 0,
      right: BAR_WIDTH,
      top: 0,
      bottom: 10,
      width: BAR_WIDTH,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect;
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect);
    return bar;
  }

  function hoverAt(bar: HTMLElement, clientX: number) {
    // Separate acts: React commits the pointerenter state (tooltip mounts)
    // before the first pointermove reads it — same ordering as real events.
    act(() => {
      fireEvent.pointerEnter(bar, { pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(bar, { clientX, pointerId: 1 });
    });
  }

  beforeEach(() => {
    fakeController.seek.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a tooltip with the duration at the hovered position and follows pointer moves", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });
    const bar = mockBarRect();

    expect(screen.queryByTestId("seek-tooltip")).toBeNull();
    hoverAt(bar, 50); // 25% of 240s = 1:00
    expect(screen.getByTestId("seek-tooltip").textContent).toBe("1:00");

    act(() => {
      fireEvent.pointerMove(bar, { clientX: 100, pointerId: 1 });
    });
    expect(screen.getByTestId("seek-tooltip").textContent).toBe("2:00");
  });

  it("does not show the tooltip while the duration is 0 (metadata not loaded)", () => {
    renderPlayer();
    const bar = mockBarRect();
    hoverAt(bar, 100);
    expect(screen.queryByTestId("seek-tooltip")).toBeNull();
  });

  it("clamps the tooltip inward so it never overflows the bar edges", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });
    const bar = mockBarRect();

    hoverAt(bar, 0); // raw anchor at the far-left edge -> clamped inward
    const tooltip = screen.getByTestId("seek-tooltip");
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThan(0);
    expect(tooltip.textContent).toBe("0:00");

    act(() => {
      fireEvent.pointerMove(bar, { clientX: BAR_WIDTH, pointerId: 1 });
    });
    expect(Number.parseFloat(tooltip.style.left)).toBeLessThan(BAR_WIDTH);
    expect(tooltip.textContent).toBe("4:00");
  });

  it("hides tooltip and buffer preview and returns the thumb to idle on pointerleave", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });
    const bar = mockBarRect();
    hoverAt(bar, 150);

    expect(screen.getByTestId("seek-tooltip")).toBeTruthy();
    expect(screen.getByTestId("seek-thumb").className).toContain("opacity-100");

    act(() => {
      fireEvent.pointerLeave(bar, { pointerId: 1 });
    });

    expect(screen.queryByTestId("seek-tooltip")).toBeNull();
    expect(screen.queryByTestId("buffer-preview")).toBeNull();
    expect(screen.getByTestId("seek-thumb").className).toContain("opacity-0");
  });

  it("keeps the thumb hidden while idle and shows it on hover", () => {
    renderPlayer();
    expect(screen.getByTestId("seek-thumb").className).toContain("opacity-0");

    const bar = mockBarRect();
    act(() => {
      fireEvent.pointerEnter(bar, { pointerId: 1 });
    });

    expect(screen.getByTestId("seek-thumb").className).toContain("opacity-100");
  });

  it("shows the thumb immediately on pointerdown even without hover", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });
    const bar = mockBarRect();

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });

    expect(screen.getByTestId("seek-thumb").className).toContain("opacity-100");

    // Complete the drag so the window listeners are removed (no leak into
    // later tests in this file).
    act(() => {
      fireEvent.pointerUp(window, { clientX: 50, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
  });

  it("keeps the thumb visible while dragging and the tooltip does not break the drag", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });
    const bar = mockBarRect();

    act(() => {
      fireEvent.pointerEnter(bar, { pointerId: 1 });
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    expect(screen.getByTestId("seek-thumb").className).toContain("opacity-100");

    act(() => {
      fireEvent.pointerMove(bar, { clientX: 100, pointerId: 1 });
    });
    expect(screen.getByTestId("seek-tooltip").className).toContain(
      "pointer-events-none",
    );

    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
  });

  it("shows the buffer preview from the UI playhead to the hovered position when hovering ahead", () => {
    renderPlayer();
    // The playhead the preview must start at is the LAST timeupdate value —
    // the same one the blue fill is showing. The raw media clock
    // (getCurrentTime) may be up to ~200ms ahead of it while playing, so the
    // test feeds the playhead through the same channel as the fill.
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 10, duration: 100 });
    });
    const bar = mockBarRect();

    hoverAt(bar, 150); // 75% of the bar

    const preview = screen.getByTestId("buffer-preview");
    expect(preview.style.left).toBe("10%");
    expect(preview.style.width).toBe("65%");
  });

  it("does not show the buffer preview when hovering before the playhead", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 50, duration: 100 });
    });
    const bar = mockBarRect();

    hoverAt(bar, 50); // 25% < playhead 50%

    expect(screen.getByTestId("buffer-preview").style.width).toBe("0%");
  });

  it("starts the preview at the last UI playhead when paused (no timeupdate drift)", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 30, duration: 100 });
    });
    // No further timeupdate (paused) — the preview must keep using the last
    // emitted playhead instead of drifting to the raw media clock.
    const bar = mockBarRect();

    hoverAt(bar, 150); // 75% of the bar

    const preview = screen.getByTestId("buffer-preview");
    expect(preview.style.left).toBe("30%");
    expect(preview.style.width).toBe("45%");
  });

  it("starts the preview at the drag position after a seek drag", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 200 });
    });
    const bar = mockBarRect();

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 100, pointerId: 1 }); // 50%
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);

    hoverAt(bar, 150); // 75% of the bar

    const preview = screen.getByTestId("buffer-preview");
    expect(preview.style.left).toBe("50%");
    expect(preview.style.width).toBe("25%");
  });

  it("starts the preview at the restored playhead when no timeupdate has fired", () => {
    renderPlayer({
      currentTrack: makeTrack({ restoreTime: 40, restoreDuration: 100 }),
    });
    const bar = mockBarRect();

    hoverAt(bar, 150); // 75% of the bar

    const preview = screen.getByTestId("buffer-preview");
    expect(preview.style.left).toBe("40%");
    expect(preview.style.width).toBe("35%");
  });

  it("BUG regression: buffer preview keeps only a small right corner (rounded-r-sm) so it reads as a continuous buffer run, not a round dot", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 10, duration: 100 });
    });
    const bar = mockBarRect();

    hoverAt(bar, 150); // 75% of the bar

    const preview = screen.getByTestId("buffer-preview");
    // The preview tail matches the buffered segment's small right corner
    // (rounded-r-sm); the flat left edge joins the fill's convex cap at the
    // playhead — no round cap on the preview side of the seam.
    expect(preview.className).toContain("rounded-r-sm");
    expect(preview.className).not.toContain("rounded-l-full");
    expect(preview.className).not.toContain("rounded-full");
  });
});

describe("PlayerBar fill rounding at the buffer seam", () => {
  const BAR_WIDTH = 200;

  function mockBarRect() {
    const bar = screen.getByTestId("buffer-fill").parentElement as HTMLElement;
    const rect = {
      left: 0,
      right: BAR_WIDTH,
      top: 0,
      bottom: 10,
      width: BAR_WIDTH,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect;
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect);
    return bar;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG regression: fill is fully rounded (rounded-full) at mid-track widths", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 50, duration: 100 });
    });

    const fill = screen.getByTestId("progress-fill");
    expect(fill.style.width).toBe("50%");
    // Original behavior restored: the fill keeps a full round cap on BOTH
    // ends at every width — no small 2px right corner and no conditional
    // toggle when the fill reaches the rail end.
    expect(fill.className).toContain("rounded-full");
    expect(fill.className).not.toContain("rounded-r-xs");
    expect(fill.className).not.toContain("rounded-r-full");
  });

  it("BUG regression: fill stays fully rounded (rounded-full) at the rail end (100%)", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 100, duration: 100 });
    });

    const fill = screen.getByTestId("progress-fill");
    expect(fill.style.width).toBe("100%");
    expect(fill.className).toContain("rounded-full");
    expect(fill.className).not.toContain("rounded-r-xs");
    expect(fill.className).not.toContain("rounded-r-full");
  });

  it("BUG regression: dragging the fill keeps it fully rounded (rounded-full) (drag path)", () => {
    renderPlayer();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });
    const bar = mockBarRect();

    act(() => {
      fireEvent.pointerDown(bar, { clientX: BAR_WIDTH, pointerId: 1 });
    });
    expect(screen.getByTestId("progress-fill").className).toContain(
      "rounded-full",
    );
    expect(screen.getByTestId("progress-fill").className).not.toContain(
      "rounded-r-xs",
    );

    act(() => {
      fireEvent.pointerUp(window, { clientX: BAR_WIDTH, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
  });

  it("BUG regression: restored session near 100% keeps the fill fully rounded (restore path)", () => {
    renderPlayer({
      currentTrack: makeTrack({ restoreTime: 99.95, restoreDuration: 100 }),
    });

    const fill = screen.getByTestId("progress-fill");
    expect(fill.className).toContain("rounded-full");
    expect(fill.className).not.toContain("rounded-r-xs");
    expect(fill.className).not.toContain("rounded-r-full");
  });
});

describe("PlayerBar track cover in TrackInfo (full picture, no drplay://)", () => {
  let createObjectURLSpy: MockInstance<(obj: Blob | MediaSource) => string>;

  beforeEach(() => {
    mockedGetTrackMetadata.mockReset();
    useAuthStore.setState({ accessToken: "tok" });
    // jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both
    // are undefined at runtime) — install observable spies so the blob URL
    // contract can be asserted.
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
    createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-playerbar-cover");
    mockedGetTrackMetadata.mockResolvedValue({
      title: "Song",
      artist: "Artist",
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureDataFull: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      pictureFormat: "image/jpeg",
    } as never);
  });

  afterEach(() => {
    useAuthStore.setState({ accessToken: null });
    vi.restoreAllMocks();
  });

  it("renders the cover from the FULL picture bytes in the 48px track box (blob src, object-cover)", async () => {
    const { container } = renderPlayer();
    const img = await screen.findByAltText("Song");

    expect(img.getAttribute("src")).toBe("blob:mock-playerbar-cover");
    expect(img.className).toContain("object-cover");
    // The blob must be built from the FULL bytes (8), not the thumb (4).
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.size).toBe(8);
    expect(blobArg.type).toBe("image/jpeg");
    expect(mockedGetTrackMetadata).toHaveBeenCalledWith(
      "track-1",
      "tok",
      undefined,
      undefined,
      expect.any(Object),
    );
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("keeps the Music icon (no img) when metadata has no picture bytes", async () => {
    mockedGetTrackMetadata.mockResolvedValue({
      title: "Song",
      artist: "Artist",
      duration: 0,
      size: 0,
      pictureData: null,
      pictureDataFull: null,
      pictureFormat: undefined,
    } as never);
    const { container } = renderPlayer();
    await waitFor(() => {
      expect(mockedGetTrackMetadata).toHaveBeenCalledTimes(1);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it("drops to the icon when the cover blob image errors (corrupt bytes)", async () => {
    const { container } = renderPlayer();
    const img = await screen.findByAltText("Song");
    expect(img.getAttribute("src")).toBe("blob:mock-playerbar-cover");

    expect(() => fireEvent.error(img)).not.toThrow();

    expect(container.querySelector("img")).toBeNull();
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches metadata when the current track changes (cover follows the new track)", async () => {
    const { rerender } = renderPlayer();
    await screen.findByAltText("Song");
    mockedGetTrackMetadata.mockClear();

    rerender(
      <PlayerBar
        currentTrack={makeTrack({ id: "track-2", title: "Song 2" })}
        isPlaying={false}
        onTogglePlay={vi.fn()}
        onNextTrack={vi.fn()}
        onPrevTrack={vi.fn()}
        playMode="normal"
        onTogglePlayMode={vi.fn()}
        onExpandNowPlaying={vi.fn()}
      />,
    );

    await screen.findByAltText("Song 2");
    expect(mockedGetTrackMetadata).toHaveBeenCalledWith(
      "track-2",
      "tok",
      undefined,
      undefined,
      expect.any(Object),
    );
    expect(screen.queryByAltText("Song")).toBeNull();
  });
});

describe("PlayerBar TrackInfo folds fetched tags into the store (tags fix)", () => {
  const REAL_METADATA = {
    title: "Real Title",
    artist: "Real Artist",
    duration: 0,
    durationEstimated: false,
    pictureData: null,
    pictureDataFull: null,
    size: 1000,
    v: 8,
  };
  const PLACEHOLDER_METADATA = {
    title: "Song",
    artist: "Unknown Artist",
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    size: 1000,
    v: 9,
  };

  beforeEach(() => {
    mockedGetTrackMetadata.mockReset();
    useAuthStore.setState({ accessToken: "tok" });
  });

  afterEach(() => {
    useAuthStore.setState({ accessToken: null });
    usePlayerStore.setState({ currentTrack: null });
    vi.restoreAllMocks();
  });

  it("BUG regression: real metadata (v:8) replaces the filename title and empty artist in the store", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack({ title: "Song", artist: "" }),
    });
    mockedGetTrackMetadata.mockResolvedValue({ ...REAL_METADATA });
    renderPlayer({ currentTrack: makeTrack({ title: "Song", artist: "" }) });

    await waitFor(() => {
      expect(usePlayerStore.getState().currentTrack?.title).toBe("Real Title");
    });
    expect(usePlayerStore.getState().currentTrack?.artist).toBe("Real Artist");
  });

  it("BUG regression: the PlayerBar title/artist TEXT updates to the fetched metadata (store wired like App)", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack({ title: "Song", artist: "" }),
    });
    mockedGetTrackMetadata.mockResolvedValue({ ...REAL_METADATA });
    render(<StoreWiredPlayerBar />);

    expect(await screen.findByText("Real Title")).toBeTruthy();
    expect(screen.getByText("Real Artist")).toBeTruthy();
  });

  it("BUG regression: a v:9 placeholder entry leaves the store untouched (same reference)", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack({ title: "Song", artist: "" }),
    });
    const initialTrack = usePlayerStore.getState().currentTrack;
    mockedGetTrackMetadata.mockResolvedValue({ ...PLACEHOLDER_METADATA });
    renderPlayer({ currentTrack: makeTrack({ title: "Song", artist: "" }) });

    await waitFor(() => {
      expect(mockedGetTrackMetadata).toHaveBeenCalledTimes(1);
    });
    expect(usePlayerStore.getState().currentTrack).toBe(initialTrack);
  });

  it("BUG regression: real entry with artist 'Unknown Artist' applies the title but keeps the empty artist", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack({ title: "Song", artist: "" }),
    });
    mockedGetTrackMetadata.mockResolvedValue({
      ...REAL_METADATA,
      artist: "Unknown Artist",
    });
    renderPlayer({ currentTrack: makeTrack({ title: "Song", artist: "" }) });

    await waitFor(() => {
      expect(usePlayerStore.getState().currentTrack?.title).toBe("Real Title");
    });
    expect(usePlayerStore.getState().currentTrack?.artist).toBe("");
  });

  it("BUG regression: abort on unmount skips setState and logs no error (stale-guard via AbortController)", async () => {
    usePlayerStore.setState({
      currentTrack: makeTrack({ title: "Song", artist: "" }),
    });
    const captureErrorSpy = vi.spyOn(errorLog, "captureError");
    let resolveFetch!: (value: never) => void;
    mockedGetTrackMetadata.mockReturnValue(
      new Promise<never>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { unmount } = renderPlayer({
      currentTrack: makeTrack({ title: "Song", artist: "" }),
    });
    await waitFor(() => {
      expect(mockedGetTrackMetadata).toHaveBeenCalledTimes(1);
    });
    unmount();
    resolveFetch({ ...REAL_METADATA } as never);
    await act(async () => {
      await Promise.resolve();
    });
    expect(captureErrorSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().currentTrack?.title).toBe("Song");
  });
});

describe("PlayerBar mobile gate (IS_MOBILE) — title only", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
    // Reset the fetch mock: earlier desktop describes call it with a token;
    // a stale call must never trip the "no fetch on mobile" assertion.
    mockedGetTrackMetadata.mockReset();
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
  });

  it("shows the title but no artist and no cover image", () => {
    renderPlayer({
      currentTrack: makeTrack({ title: "Song", artist: "Artist" }),
    });
    expect(screen.getByText("Song")).not.toBeNull();
    expect(screen.queryByText("Artist")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("never fetches cover metadata on mobile", async () => {
    renderPlayer({ currentTrack: makeTrack() });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedGetTrackMetadata).not.toHaveBeenCalled();
  });
});
