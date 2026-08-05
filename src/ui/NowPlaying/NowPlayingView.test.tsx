// @vitest-environment jsdom
import type { ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../App";
import { NowPlayingView } from "./NowPlayingView";
import en from "../../locales/en/translation.json";

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
    "Music",
    "ChevronDown",
    "Play",
    "Pause",
    "SkipBack",
    "SkipForward",
    "Repeat",
    "Repeat1",
    "Shuffle",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

vi.mock("./hooks/useNowPlayingMetadata", () => ({
  useNowPlayingMetadata: () => ({
    coverUrl: null,
    realTitle: "Song",
    realArtist: "Artist",
    bgColor: "",
    bgPalette: [],
  }),
}));

const { fakeController } = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  const fakeController = {
    on: vi.fn(),
    getDuration: vi.fn(() => 0),
    getCurrentTime: vi.fn(() => 0),
    getBuffered: vi.fn(),
    seek: vi.fn(),
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

type ViewProps = ComponentProps<typeof NowPlayingView>;

function renderView(overrides: Partial<ViewProps> = {}) {
  return render(
    <NowPlayingView
      currentTrack={makeTrack()}
      isPlaying={false}
      onTogglePlay={vi.fn()}
      onNextTrack={vi.fn()}
      onPrevTrack={vi.fn()}
      playMode="normal"
      onTogglePlayMode={vi.fn()}
      onBack={vi.fn()}
      isOpen={true}
      token={null}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  fakeController.on.mockClear();
  fakeController.getDuration.mockClear();
  fakeController.getCurrentTime.mockClear();
  fakeController.getBuffered.mockClear();
  fakeController.seek.mockClear();
  installFakeOn();
  fakeController.getDuration.mockReturnValue(0);
  setBuffered([]);
  fakeController._handlers = {};
});

afterEach(() => {
  cleanup();
  fakeController._handlers = {};
});

describe("NowPlayingView buffer bar", () => {
  it("BUG regression: buffer container is pinned full-width and transparent (segment children own the background)", () => {
    renderView();
    const buffer = screen.getByTestId("buffer-fill");

    // Container must be pinned to the full progress-bar track (inset-0 / w-full
    // / right-0) — never a shrink-to-fit `absolute left-0` box whose width
    // computes to 0 (CSS2.1 §10.3.7), collapsing the child % segments.
    expect(buffer.className).toMatch(/\b(inset-0|w-full)\b|\bright-0\b/);
    // Container must be transparent — the buffered segment children created by
    // updateBufferBar() (bg-gray-400) are the visible part.
    expect(buffer.className).not.toMatch(/\bbg-/);
  });

  it("BUG regression: emitting progress renders a visible segment child (bg-gray-400) inside the transparent container", () => {
    renderView();
    const buffer = screen.getByTestId("buffer-fill");
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    // The segment — not the container — carries the visible buffer background.
    expect(seg.className).toMatch(/\bbg-gray-400\b/);
    // Future-only buffer: [10,300] of duration 1000 -> 1% / 29%.
    expect(seg.style.left).toBe(`${String((10 / 1000) * 100)}%`);
    expect(seg.style.width).toBe(`${String((290 / 1000) * 100)}%`);
  });

  it("BUG regression: timeupdate re-renders the buffer bar from audio.buffered (progress race)", () => {
    renderView();
    const buffer = screen.getByTestId("buffer-fill");
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 10, duration: 1000 });
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    // Future-only buffer: [10,300] of duration 1000 -> 1% / 29%.
    expect(seg.style.left).toBe(`${String((10 / 1000) * 100)}%`);
    expect(seg.style.width).toBe(`${String((290 / 1000) * 100)}%`);
  });

  it("unsubscribes the progress handler on unmount (no listener leak)", () => {
    const { unmount } = renderView();
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);

    unmount();

    expect(fakeController._handlers["progress"] ?? []).toHaveLength(0);
  });
});

describe("NowPlayingView a11y progressbar", () => {
  it('exposes the progress bar with role="progressbar" and a bounded ARIA value range', () => {
    renderView();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  it("gives the progressbar an accessible name", () => {
    renderView();
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Playback progress",
    );
  });

  it("syncs aria-valuenow to the seek position when a drag is committed", () => {
    renderView();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    const bar = screen.getByRole("progressbar");
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
      fireEvent.pointerUp(window, { clientX: 50, pointerId: 1 });
    });

    expect(bar.getAttribute("aria-valuenow")).toBe("25");
  });
});
