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

const { captureErrorMock } = vi.hoisted(() => ({
  captureErrorMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../utils/errorLog", () => ({ captureError: captureErrorMock }));

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
  captureErrorMock.mockClear();
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

  it("BUG regression (S3): Ctrl/Meta/Alt+Arrow chords neither preventDefault nor seek (webview history-nav survives)", () => {
    renderSeekBar();
    fakeController.getDuration.mockReturnValue(240);

    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const key of ["ArrowLeft", "ArrowRight"] as const) {
        const init: KeyboardEventInit = { key, cancelable: true };
        init[modifier] = true;
        const evt = new KeyboardEvent("keydown", init);
        act(() => {
          window.dispatchEvent(evt);
        });
        expect(
          evt.defaultPrevented,
          `${modifier}+${key} must reach the browser`,
        ).toBe(false);
      }
    }
    expect(fakeController.seek).not.toHaveBeenCalled();
  });

  it("BUG regression (S3): held-arrow auto-repeat keeps seeking (hold-to-scrub is the intended player convention)", () => {
    renderSeekBar();
    fakeController.getDuration.mockReturnValue(240);
    fakeController.getCurrentTime.mockReturnValueOnce(10);

    const evt = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      repeat: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(evt);
    });

    expect(evt.defaultPrevented).toBe(true);
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(15);
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

describe("SeekBar progress fill clipper + rail-anchored thumb (needle fix v2)", () => {
  it("BUG regression: the fill width stays the TRUE percent at tiny progress (no min-width notch) and the thumb `left` matches it", () => {
    renderSeekBar();
    // 30s into a 2h track = 0.41666...% — the fill must keep this true
    // width. The rail's overflow-hidden rounded-full clipper rounds any
    // width to the track contour, so the old 6px min-width clamp (which
    // jumped the fill 0→6px as soon as progress > 0, reading as "a notch
    // sitting there while seeking") is gone — minWidth must never be set.
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 30, duration: 7200 });
    });

    const fill = screen.getByTestId("progress-fill");
    expect(fill.style.width).toContain("0.4166");
    expect(fill.style.minWidth).toBe("");
    const thumb = screen.getByTestId("seek-thumb");
    expect(thumb.style.left).toContain("0.4166");
  });

  it("BUG regression: currentTime 0 writes the thumb at left 0% (same write-point as the fill)", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 30, duration: 7200 });
    });
    act(() => {
      fakeController._emit("timeupdate", { currentTime: 0, duration: 7200 });
    });

    const thumb = screen.getByTestId("seek-thumb");
    expect(thumb.style.left).toBe("0%");
  });

  it("BUG regression: the fill is wrapped by an overflow-hidden rounded-full clipper (rounded contour at any width, iifx/SO pattern)", () => {
    renderSeekBar();

    const clip = screen.getByTestId("progress-fill")
      .parentElement as HTMLElement;
    expect(clip.className).toContain("overflow-hidden");
    expect(clip.className).toContain("rounded-full");
  });

  it("BUG regression: the thumb is NOT inside the clipper — a direct child of the rail so the 0%/100% half-overhang is never cut", () => {
    renderSeekBar();

    const thumb = screen.getByTestId("seek-thumb");
    const rail = screen.getByRole("progressbar");
    expect(thumb.parentElement).toBe(rail);
  });

  it("desktop idle keeps the thumb hidden and scaled down (opacity-0 + scale-75, never scale-100)", () => {
    renderSeekBar();
    const thumb = screen.getByTestId("seek-thumb");
    expect(thumb.className).toContain("opacity-0");
    expect(thumb.className).not.toContain("opacity-100");
    expect(thumb.className).toContain("scale-75");
    expect(thumb.className).not.toContain("scale-100");
  });

  it("desktop hover reveals the thumb (opacity-100 + scale-100)", () => {
    renderSeekBar();
    const rail = screen.getByTestId("buffer-fill").parentElement as HTMLElement;

    act(() => {
      fireEvent.pointerEnter(rail, { pointerId: 1 });
    });

    const thumb = screen.getByTestId("seek-thumb");
    expect(thumb.className).toContain("opacity-100");
    expect(thumb.className).toContain("scale-100");
  });
});

describe("SeekBar drag pointer ownership (S1 multi-touch)", () => {
  it("BUG regression (S1): a second finger landing mid-drag is ignored — its move/up must not seek and the owning finger stays in control", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });
    const bar = mockBarRect();

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    // Second finger lands while finger 1 is dragging: registering a second
    // parallel listener set is the bug — it must be ignored wholesale.
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 150, pointerId: 2 });
    });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 170, pointerId: 2 });
    });
    // Finger 2 lifts first: no seek may be committed from a foreign pointer.
    act(() => {
      fireEvent.pointerUp(window, { clientX: 150, pointerId: 2 });
    });
    expect(fakeController.seek).not.toHaveBeenCalled();
    expect(screen.getByTestId("progress-fill").style.width).toBe("25%");

    // The owning finger keeps full control of the drag.
    act(() => {
      fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
  });

  it("BUG regression (S1): unmount mid multi-touch drag removes the active pointer's listeners too (no leaked stray seek)", () => {
    const { unmount } = renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });
    const bar = mockBarRect();

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerDown(bar, { clientX: 150, pointerId: 2 });
    });
    unmount();

    // The still-registered owner set (finger 1) must have been removed with
    // the unmount, not orphaned by the overwritten cleanup refs.
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 150, pointerId: 2 });
    });
    expect(fakeController.seek).not.toHaveBeenCalled();
  });

  it("BUG regression (S1): pointercancel from a foreign pointer is ignored — only the owning pointer reaches commit", () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });
    const bar = mockBarRect();

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      // No fireEvent.pointercancel helper exists — dispatch the native event
      // straight onto window where the drag listeners live.
      window.dispatchEvent(
        new PointerEvent("pointercancel", { clientX: 150, pointerId: 2 }),
      );
    });
    expect(fakeController.seek).not.toHaveBeenCalled();

    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(fakeController.seek).toHaveBeenCalledTimes(1);
    expect(fakeController.seek).toHaveBeenCalledWith(120);
  });

  it("BUG regression (S2): a rejected native seek is caught and logged, and the UI snaps back to the engine's real position", async () => {
    renderSeekBar();
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });
    fakeController.getCurrentTime.mockReturnValueOnce(60);
    fakeController.seek.mockRejectedValueOnce(new Error("seek_to failed"));
    const bar = mockBarRect();

    // Commit a drag whose target (clamped to 240s) the native engine rejects.
    await act(async () => {
      fireEvent.pointerDown(bar, { clientX: 50, pointerId: 1 });
      fireEvent.pointerUp(window, { clientX: 240, pointerId: 1 });
      // Flush the rejection microtask chain inside act so the recovery
      // (restore + log) lands before the assertions below.
      await Promise.resolve();
    });

    // No unhandled rejection: the failure is logged warn-level with context.
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "SeekBar" }),
    );
    // Fill/clock restored to the engine's real position (60s of 240s) instead
    // of staying stranded at the failed seek target.
    expect(screen.getByTestId("progress-fill").style.width).toBe("25%");
    expect(screen.getByText("1:00")).toBeTruthy();
  });
});
