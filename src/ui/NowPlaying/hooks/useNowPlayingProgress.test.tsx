// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../../App";
import { formatTime } from "../../../utils/formatTime";
import { useNowPlayingProgress } from "./useNowPlayingProgress";

const { fakeController } = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  const fakeController = {
    on: vi.fn(),
    getDuration: vi.fn(() => 0),
    getBuffered: vi.fn(),
    seek: vi.fn(),
    _handlers: {} as Record<string, Handler[]>,
    _emit(event: string, payload?: unknown) {
      for (const h of fakeController._handlers[event] ?? []) h(payload);
    },
  };
  return { fakeController };
});

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

vi.mock("../../../lib/AudioController", () => ({
  AudioController: { getInstance: () => fakeController },
}));

vi.mock("../../../lib/AudioController", () => ({
  AudioController: { getInstance: () => fakeController },
}));

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "Song",
    artist: "Artist",
    streamUrl: "/drive-stream/track-1",
    ...overrides,
  };
}

function Harness({ track, isOpen }: { track: Track | null; isOpen: boolean }) {
  const {
    duration,
    progressBarRef,
    progressFillRef,
    bufferFillRef,
    currentTimeTextRef,
    handlePointerDown,
  } = useNowPlayingProgress(track, isOpen);
  return (
    <div>
      <span ref={currentTimeTextRef} data-testid="time">
        0:00
      </span>
      <span data-testid="duration">{formatTime(duration)}</span>
      <div
        ref={progressBarRef}
        data-testid="bar"
        onPointerDown={handlePointerDown}
      >
        <div ref={bufferFillRef} data-testid="buffer"></div>
        <div
          ref={progressFillRef}
          data-testid="fill"
          style={{ width: "0%" }}
        ></div>
      </div>
    </div>
  );
}

beforeEach(() => {
  fakeController.on.mockClear();
  fakeController.seek.mockClear();
  fakeController.getDuration.mockClear();
  fakeController.getBuffered.mockClear();
  installFakeOn();
  fakeController.getDuration.mockReturnValue(0);
  setBuffered([]);
  fakeController._handlers = {};
});

afterEach(() => {
  cleanup();
  fakeController._handlers = {};
});

describe("useNowPlayingProgress — progress sync driven by AudioController events", () => {
  it("BUG regression: updates progress fill + time text when AudioController emits timeupdate", () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    expect(screen.getByTestId("time").textContent).toBe("0:00");

    act(() => {
      fakeController._emit("timeupdate", { currentTime: 60, duration: 240 });
    });

    expect(screen.getByTestId("time").textContent).toBe("1:00");
    expect(screen.getByTestId("fill").style.width).toBe("25%");
  });

  it("BUG regression: syncs duration state from AudioController durationchange event", () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    expect(screen.getByTestId("duration").textContent).toBe("0:00");

    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    expect(screen.getByTestId("duration").textContent).toBe("4:00");
  });

  it("seeds duration from AudioController.getDuration() on mount", () => {
    fakeController.getDuration.mockReturnValue(300);
    render(<Harness track={makeTrack()} isOpen={true} />);
    expect(screen.getByTestId("duration").textContent).toBe("5:00");
  });

  it("commits a drag via AudioController.seek (not a DOM audio element)", () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    const bar = screen.getByTestId("bar");
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
  });

  it("BUG regression: drag uses fresh duration when durationchange arrives mid-drag (no seek-to-0 race)", () => {
    render(<Harness track={makeTrack()} isOpen={true} />);

    const bar = screen.getByTestId("bar");
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
      fakeController._emit("durationchange", { duration: 240 });
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

  it("BUG regression: buffer bar renders audio.buffered segments when AudioController emits progress", () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    const buffer = screen.getByTestId("buffer");
    expect(buffer.childElementCount).toBe(0);

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });

    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    // Future-only buffer: [10,300] of duration 1000 -> 1% / 29%.
    expect(seg.style.left).toBe(`${String((10 / 1000) * 100)}%`);
    expect(seg.style.width).toBe(`${String((290 / 1000) * 100)}%`);
  });

  it("BUG regression: forward seek shows only the future buffered segment (pre-seek past range dropped)", () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    const buffer = screen.getByTestId("buffer");

    setBuffered(
      [
        [0, 30],
        [500, 510],
      ],
      1000,
      505,
    );
    act(() => {
      fakeController._emit("progress");
    });

    // Pre-seek [0,30] ends before currentTime=505 -> dropped entirely; [500,510]
    // is clipped to the future part [505,510]: 50.5% / 0.5% of duration 1000.
    expect(buffer.childElementCount).toBe(1);
    expect((buffer.children[0] as HTMLElement).style.left).toBe("50.5%");
    expect((buffer.children[0] as HTMLElement).style.width).toBe("0.5%");
  });

  it("BUG regression: buffer bar clears when buffered data becomes empty", () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    const buffer = screen.getByTestId("buffer");

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

  it("subscribes to progress events even when the view is closed (buffer populates before opening)", () => {
    render(<Harness track={makeTrack()} isOpen={false} />);
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);
  });

  it("unsubscribes timeupdate, durationchange and progress handlers on unmount (no listener leak)", () => {
    const { unmount } = render(<Harness track={makeTrack()} isOpen={true} />);
    expect(fakeController._handlers["timeupdate"]).toHaveLength(1);
    expect(fakeController._handlers["durationchange"]).toHaveLength(1);
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);

    unmount();

    expect(fakeController._handlers["timeupdate"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["durationchange"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(0);
  });

  it("does not subscribe to realtime timeupdate when the view is closed, but still subscribes progress", () => {
    render(<Harness track={makeTrack()} isOpen={false} />);
    expect(fakeController._handlers["timeupdate"] ?? []).toHaveLength(0);
    expect(fakeController._handlers["progress"] ?? []).toHaveLength(1);
  });

  it("BUG regression: drag commit (pointerup) redraws the buffer bar synchronously after seek (no empty-blink)", () => {
    render(<Harness track={makeTrack()} isOpen={true} />);
    const buffer = screen.getByTestId("buffer");
    act(() => {
      fakeController._emit("durationchange", { duration: 240 });
    });

    setBuffered([[0, 300]]);
    act(() => {
      fakeController._emit("progress");
    });
    expect(buffer.childElementCount).toBe(1);

    const bar = screen.getByTestId("bar");
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

  it("BUG regression: removes window drag listeners when unmounting mid-drag (no leak, no stray seek)", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Harness track={makeTrack()} isOpen={true} />);
    const bar = screen.getByTestId("bar");
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
