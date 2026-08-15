// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import type { AudioController } from "../../lib/AudioController";
import { SeekBar } from "./SeekBar";
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

// Task 5: the mobile full-width drag surface is gated by IS_MOBILE — hoisted
// toggle mirrors the PlayerBar.test pattern.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
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

interface RenderSeekBarOverrides {
  track?: Track | null;
  audio?: AudioController;
  active?: boolean;
  keyboardSeek?: boolean;
}

function renderSeekBar(overrides: RenderSeekBarOverrides = {}) {
  return render(
    <SeekBar
      currentTrack={makeTrack()}
      audio={fakeController as unknown as AudioController}
      {...overrides}
    />,
  );
}

function mockBarRect() {
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

beforeEach(() => {
  fakeController.on.mockClear();
  fakeController.getDuration.mockClear();
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

describe("SeekBar progress sync driven by AudioController events", () => {
  it("BUG regression: updates progress fill + time text when AudioController emits timeupdate", () => {
    renderSeekBar();

    act(() => {
      fakeController._emit("timeupdate", { currentTime: 60, duration: 240 });
    });

    expect(screen.getByText("1:00")).toBeTruthy();
    expect(screen.getByTestId("progress-fill").style.width).toBe("25%");
  });

  it("BUG regression: syncs duration state from AudioController durationchange event", () => {
    renderSeekBar();

    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    expect(screen.getByText("4:00")).toBeTruthy();
  });

  it("seeds duration from AudioController.getDuration() on mount", () => {
    fakeController.getDuration.mockReturnValue(300);
    renderSeekBar();
    expect(screen.getByText("5:00")).toBeTruthy();
  });

  it("commits a drag via AudioController.seek (not a DOM audio element)", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    const bar = mockBarRect();
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
  });

  it("BUG regression: drag uses fresh duration when durationchange arrives mid-drag (no seek-to-0 race)", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    const bar = mockBarRect();
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });

    act(() => {
      fakeController._emit("durationchange", { duration: 480 });
    });

    act(() => {
      fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(240);
  });

  it("BUG regression: buffer bar renders audio.buffered segments when AudioController emits progress", () => {
    renderSeekBar();
    const buffer = screen.getByTestId("buffer-fill");
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("30%");
  });

  it("BUG regression: forward seek shows only the future buffered segment (pre-seek past range dropped)", () => {
    renderSeekBar();
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

  it("BUG regression: buffer bar clears when buffered data becomes empty", () => {
    renderSeekBar();
    const buffer = screen.getByTestId("buffer-fill");

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });
    expect(buffer.childElementCount).toBe(1);

    setBuffered([], 1000, 10);
    act(() => {
      fakeController._emit("progress");
    });
    expect(buffer.childElementCount).toBe(0);
  });

  it("subscribes to progress events even when inactive (buffer populates before the view opens)", () => {
    renderSeekBar({ active: false });
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);
  });

  it("unsubscribes timeupdate, durationchange and progress handlers on unmount (no listener leak)", () => {
    const { unmount } = renderSeekBar();
    expect(fakeController._handlers["timeupdate"]).toHaveLength(1);
    expect(fakeController._handlers["durationchange"]).toHaveLength(1);
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);

    unmount();

    expect(fakeController._handlers["timeupdate"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["durationchange"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(0);
  });

  it("does not subscribe to realtime timeupdate when inactive, but still subscribes progress", () => {
    renderSeekBar({ active: false });
    expect(fakeController._handlers["timeupdate"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);
  });

  it("BUG regression: drag commit (pointerup) redraws the buffer bar synchronously after seek (no empty-blink)", () => {
    renderSeekBar();
    const buffer = screen.getByTestId("buffer-fill");
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });
    expect(buffer.childElementCount).toBe(1);

    const bar = mockBarRect();
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

  it("BUG regression: removes window drag listeners when unmounting mid-drag (no leak, no stray seek)", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(
      <SeekBar
        currentTrack={makeTrack()}
        audio={fakeController as unknown as AudioController}
      />,
    );
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });
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

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    expect(fakeController.seek).not.toHaveBeenCalled();

    removeSpy.mockClear();
    unmount();

    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith(
      "pointercancel",
      expect.any(Function),
    );

    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(fakeController.seek).not.toHaveBeenCalled();

    removeSpy.mockRestore();
  });
});

describe("SeekBar buffer bar", () => {
  it("BUG regression: buffer container is pinned full-width and transparent (segment children own the background)", () => {
    renderSeekBar();
    const buffer = screen.getByTestId("buffer-fill");

    expect(buffer.className).toMatch(/\b(inset-0|w-full)\b|\bright-0\b/);
    expect(buffer.className).not.toMatch(/\bbg-/);
  });

  it("BUG regression: emitting progress renders a visible segment child (bg-gray-400) inside the transparent container", () => {
    renderSeekBar();
    const buffer = screen.getByTestId("buffer-fill");
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    expect(seg.className).toMatch(/\bbg-gray-400\b/);
    expect(seg.className).toContain("rounded-r-sm");
    expect(seg.className).not.toContain("rounded-l-full");
    expect(seg.className).not.toContain("rounded-full");
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("30%");
  });

  it("BUG regression: timeupdate re-renders the buffer bar from audio.buffered (progress race)", () => {
    renderSeekBar();
    const buffer = screen.getByTestId("buffer-fill");
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 10, duration: 1000 });
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("30%");
  });

  it("BUG regression: range starting at the timeupdate playhead renders fully (drop filters use the playhead, not the raw clock)", () => {
    renderSeekBar();
    const buffer = screen.getByTestId("buffer-fill");

    setBuffered([[50, 100]], 100, 60);
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 50, duration: 100 });
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    expect(seg.style.left).toBe("48%");
    expect(seg.style.width).toBe("52%");
  });

  it("unsubscribes the progress handler on unmount (no listener leak)", () => {
    const { unmount } = renderSeekBar();
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);

    unmount();

    expect(fakeController._handlers["progress"] ?? []).toHaveLength(0);
  });
});

describe("SeekBar a11y progressbar", () => {
  it('exposes the progress bar with role="progressbar" and a bounded ARIA value range', () => {
    renderSeekBar();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  it("gives the progressbar an accessible name", () => {
    renderSeekBar();
    expect(screen.getByRole("progressbar").getAttribute("aria-label")).toBe(
      "Playback progress",
    );
  });

  it("syncs aria-valuenow to the seek position when a drag is committed", () => {
    vi.useFakeTimers();
    try {
      renderSeekBar();
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
      // The drag release delay (150ms) commits isDragging before the mirror
      // re-renders — flush it so the fill width lands in aria-valuenow.
      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(bar.getAttribute("aria-valuenow")).toBe("25");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SeekBar fill rounding at the buffer seam", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG regression: fill is fully rounded (rounded-full) at mid-track widths", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 100 });
    });
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 50, duration: 100 });
    });
    act(() => {
      fakeController._emit("durationchange", { duration: 101 });
    });

    const fill = screen.getByTestId("progress-fill");
    expect(fill.style.width).toBe("50%");
    expect(fill.className).toContain("rounded-full");
    expect(fill.className).not.toContain("rounded-r-xs");
    expect(fill.className).not.toContain("rounded-r-full");
  });

  it("BUG regression: fill stays fully rounded (rounded-full) at the rail end (100%)", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 100 });
    });
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 100, duration: 100 });
    });
    act(() => {
      fakeController._emit("durationchange", { duration: 101 });
    });

    const fill = screen.getByTestId("progress-fill");
    expect(fill.style.width).toBe("100%");
    expect(fill.className).toContain("rounded-full");
    expect(fill.className).not.toContain("rounded-r-xs");
    expect(fill.className).not.toContain("rounded-r-full");
  });

  it("BUG regression: dragging the fill keeps it fully rounded (rounded-full) (drag path)", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });
    const bar = mockBarRect();

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 200, pointerId: 1 });
    });
    expect(screen.getByTestId("progress-fill").className).toContain(
      "rounded-full",
    );
    expect(screen.getByTestId("progress-fill").className).not.toContain(
      "rounded-r-xs",
    );

    act(() => {
      fireEvent.pointerUp(window, { clientX: 200, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
  });
});

describe("SeekBar keyboard seek gating", () => {
  beforeEach(() => {
    fakeController.seek.mockClear();
  });

  it("BUG regression: keyboardSeek=false disables ArrowLeft/ArrowRight seek (NowPlaying delegates to the PlayerBar instance)", () => {
    renderSeekBar({ keyboardSeek: false });
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 240 });
    });

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowLeft" });
    });

    expect(fakeController.seek).not.toHaveBeenCalled();
  });

  it("BUG regression: PlayerBar + NowPlaying instances do not double-seek (2x5s) on ArrowRight", () => {
    renderSeekBar(); // PlayerBar instance — keyboardSeek defaults to true
    renderSeekBar({ keyboardSeek: false }); // NowPlaying instance
    fakeController.getDuration.mockReturnValue(240);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(5);
  });

  it("BUG regression: ArrowRight không seek về 0 khi duration chưa load (duration=0, currentTime=30 → giữ nguyên vị trí)", () => {
    renderSeekBar();
    fakeController.getDuration.mockReturnValue(0);
    fakeController.getCurrentTime.mockReturnValue(30);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });

    expect(fakeController.seek).not.toHaveBeenCalled();
  });

  it("default keyboardSeek seeks with ArrowRight and redraws the buffer bar synchronously", () => {
    renderSeekBar();
    fakeController.getDuration.mockReturnValue(240);
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
    expect(buffer.childElementCount).toBe(1);
  });
});

describe("SeekBar active gating (NowPlaying closed view)", () => {
  it("BUG regression: emitting timeupdate while inactive does not move the fill", () => {
    renderSeekBar({ active: false });
    expect(screen.getByTestId("progress-fill").style.width).toBe("0%");

    act(() => {
      fakeController._emit("timeupdate", { currentTime: 60, duration: 240 });
    });

    expect(screen.getByTestId("progress-fill").style.width).toBe("0%");
  });

  it("re-subscribes timeupdate when active flips back to true and moves the fill", () => {
    const { rerender } = renderSeekBar({ active: false });
    expect(fakeController._handlers["timeupdate"] ?? []).toHaveLength(0);

    rerender(
      <SeekBar
        currentTrack={makeTrack()}
        audio={fakeController as unknown as AudioController}
        active={true}
      />,
    );
    expect(fakeController._handlers["timeupdate"] ?? []).toHaveLength(1);

    act(() => {
      fakeController._emit("timeupdate", { currentTime: 60, duration: 240 });
    });
    expect(screen.getByTestId("progress-fill").style.width).toBe("25%");
  });
});

describe("SeekBar interleaved layout (time spans on both sides of the bar)", () => {
  it("renders start time before the bar and end time after the bar (no both-times-on-one-side regression)", () => {
    const { container } = renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    const bar = screen.getByRole("progressbar");
    // The bar's siblings within the flex row are the two time spans — the
    // start clock on the left, the end duration on the right. This asserts
    // DOM ORDER, which text queries can't: the split regression stacked both
    // spans before the bar and no old test caught it.
    expect(bar.previousElementSibling?.tagName).toBe("SPAN");
    expect(bar.nextElementSibling?.tagName).toBe("SPAN");
    expect(bar.nextElementSibling?.textContent).toBe("4:00");
    expect(container.firstElementChild?.firstElementChild?.tagName).toBe(
      "SPAN",
    );
    expect(container.firstElementChild?.lastElementChild?.tagName).toBe("SPAN");
  });
});

describe("SeekBar mobile full-width drag surface (Task 5 — IS_MOBILE)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
  });

  function mockRowRect(width = 200) {
    const rail = screen.getByTestId("buffer-fill").parentElement as HTMLElement;
    const row = rail.parentElement as HTMLElement;
    const rect = {
      left: 0,
      right: width,
      top: 0,
      bottom: 10,
      width,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect);
    return row;
  }

  it("BUG regression (root cause): rail carries touch-none so the WebView gesture recognizer cannot hijack the drag (was: no touch-action -> pointercancel on move -> tap-only)", () => {
    renderSeekBar();
    const rail = screen.getByTestId("buffer-fill").parentElement as HTMLElement;
    expect(rail.className).toContain("touch-none");
  });

  it("BUG regression (root cause): the ROW (mobile drag surface) carries touch-none too — a drag started over the flanking clocks would otherwise be hijacked by the WebView (rail-only touch-action dies at the row edge, killing the full-width surface)", () => {
    renderSeekBar();
    const rail = screen.getByTestId("buffer-fill").parentElement as HTMLElement;
    const row = rail.parentElement as HTMLElement;
    expect(row.className).toContain("touch-none");
  });

  it("mobile: dragging the full-width row seeks by the ROW bounds (seek surface = whole row, not just the rail)", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });
    const row = mockRowRect();

    act(() => {
      fireEvent.pointerDown(row, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
  });

  it("mobile: pointerdown over the time clock (outside the rail) still starts a drag (full-width surface)", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });
    const row = mockRowRect();

    act(() => {
      fireEvent.pointerDown(row, { clientX: 20, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 20, pointerId: 1 });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(24);
  });
});
