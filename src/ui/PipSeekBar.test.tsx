// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipSeekBar, toTimeRanges } from "./PipSeekBar";
import type { BufferedRangePayload } from "../lib/pipWindow";
import en from "../locales/en/translation.json";

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

const BAR_WIDTH_PX = 200;

function mockRailRect(width = BAR_WIDTH_PX): HTMLElement {
  const rail = screen.getByRole("slider");
  const rect = {
    left: 0,
    right: width,
    top: 0,
    bottom: 10,
    width,
    height: 10,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  } as DOMRect;
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(rect);
  return rail;
}

interface RenderPipSeekBarOverrides {
  currentTime?: number;
  duration?: number;
  buffered?: BufferedRangePayload[];
  disabled?: boolean;
  showClocks?: boolean;
  onSeek?: (time: number) => void;
}

function renderPipSeekBar(overrides: RenderPipSeekBarOverrides = {}) {
  const onSeek = overrides.onSeek ?? vi.fn();
  const view = render(
    <PipSeekBar
      currentTime={overrides.currentTime ?? 0}
      duration={overrides.duration ?? 100}
      buffered={overrides.buffered ?? []}
      disabled={overrides.disabled ?? false}
      onSeek={onSeek}
      {...(overrides.showClocks === undefined
        ? {}
        : { showClocks: overrides.showClocks })}
    />,
  );
  return { ...view, onSeek };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("toTimeRanges adapter", () => {
  it("adapts plain {start,end} segments to the TimeRanges shape", () => {
    const ranges = toTimeRanges([
      { start: 5, end: 12 },
      { start: 20, end: 30 },
    ]);

    expect(ranges.length).toBe(2);
    expect(ranges.start(0)).toBe(5);
    expect(ranges.end(0)).toBe(12);
    expect(ranges.start(1)).toBe(20);
    expect(ranges.end(1)).toBe(30);
  });

  it("is empty (and never throws) for an empty list or an out-of-range index", () => {
    const empty = toTimeRanges([]);
    expect(empty.length).toBe(0);
    expect(empty.start(0)).toBe(0);
    expect(empty.end(3)).toBe(0);
  });
});

describe("PipSeekBar a11y", () => {
  it("exposes the rail as a bounded slider with an accessible name", () => {
    renderPipSeekBar();
    const rail = screen.getByRole("slider");

    // The name comes from the SHARED SeekRail (now_playing.progress), not from
    // a PiP-local label: the rail is one component, so its a11y contract is one
    // label across PlayerBar / full-screen / PiP.
    expect(rail.getAttribute("aria-label")).toBe("Playback progress");
    expect(rail.getAttribute("aria-valuemin")).toBe("0");
    expect(rail.getAttribute("aria-valuemax")).toBe("100");
    expect(rail.tabIndex).toBe(0);
  });

  it("mirrors the playhead into aria-valuenow / aria-valuetext", () => {
    renderPipSeekBar({ currentTime: 65, duration: 240 });
    const rail = screen.getByRole("slider");

    // 65 / 240 ≈ 27%.
    expect(rail.getAttribute("aria-valuenow")).toBe("27");
    expect(rail.getAttribute("aria-valuetext")).toBe("1:05");
  });
});

describe("PipSeekBar progress sync", () => {
  it("sizes the fill from currentTime/duration", () => {
    renderPipSeekBar({ currentTime: 25, duration: 100 });
    expect(screen.getByTestId("progress-fill").style.width).toBe("25%");
  });

  it("clamps the fill into 0..100 when currentTime overshoots duration", () => {
    renderPipSeekBar({ currentTime: 150, duration: 100 });
    expect(screen.getByTestId("progress-fill").style.width).toBe("100%");
  });

  it("renders the current clock and the duration clock", () => {
    renderPipSeekBar({ currentTime: 65, duration: 240 });
    expect(screen.getByText("1:05")).toBeTruthy();
    expect(screen.getByText("4:00")).toBeTruthy();
  });

  it("shows the --:-- placeholder before a duration is known", () => {
    renderPipSeekBar({ duration: 0 });
    expect(screen.getByText("--:--")).toBeTruthy();
  });

  it("omits both clocks when showClocks is false (compact row)", () => {
    const { container } = renderPipSeekBar({
      currentTime: 65,
      duration: 240,
      showClocks: false,
    });

    expect(container.textContent).toBe("");
    expect(screen.getByRole("slider")).toBeTruthy();
  });

  it("updates the fill when currentTime changes without a drag", () => {
    const { rerender, onSeek } = renderPipSeekBar({
      currentTime: 10,
      duration: 100,
    });
    expect(screen.getByTestId("progress-fill").style.width).toBe("10%");

    rerender(
      <PipSeekBar
        currentTime={40}
        duration={100}
        buffered={[]}
        disabled={false}
        onSeek={onSeek}
      />,
    );

    expect(screen.getByTestId("progress-fill").style.width).toBe("40%");
  });
});

describe("PipSeekBar buffer segments", () => {
  it("draws one segment per buffered range with the padded head geometry", () => {
    renderPipSeekBar({
      currentTime: 5,
      duration: 100,
      buffered: [{ start: 5, end: 12 }],
    });

    const buffer = screen.getByTestId("buffer-fill");
    expect(buffer.childElementCount).toBe(1);
    const seg = buffer.children[0] as HTMLElement;
    // 2% head pad on a 100s track → the head is pulled back to 3s; the tail
    // stays at 12s, so the segment spans [3%, 12%].
    expect(seg.style.left).toBe("3%");
    expect(seg.style.width).toBe("9%");
  });

  it("renders nothing for an empty buffered list (no crash)", () => {
    renderPipSeekBar({ currentTime: 5, duration: 100, buffered: [] });
    expect(screen.getByTestId("buffer-fill").childElementCount).toBe(0);
  });

  it("clears stale segments when buffered becomes empty", () => {
    const { rerender, onSeek } = renderPipSeekBar({
      currentTime: 5,
      duration: 100,
      buffered: [{ start: 5, end: 12 }],
    });
    expect(screen.getByTestId("buffer-fill").childElementCount).toBe(1);

    rerender(
      <PipSeekBar
        currentTime={5}
        duration={100}
        buffered={[]}
        disabled={false}
        onSeek={onSeek}
      />,
    );

    expect(screen.getByTestId("buffer-fill").childElementCount).toBe(0);
  });
});

describe("PipSeekBar hover", () => {
  it("shows the time tooltip and the thumb while hovering", () => {
    renderPipSeekBar({ currentTime: 0, duration: 240 });
    const rail = mockRailRect();

    act(() => {
      fireEvent.pointerEnter(rail, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(rail, { clientX: 100, pointerId: 1 });
    });

    const tooltip = screen.getByTestId("seek-tooltip");
    // 100 / 200 px of a 240s track = 2:00.
    expect(tooltip.textContent).toBe("2:00");
    expect(screen.getByTestId("seek-thumb").className).toContain("opacity-100");
  });

  it("hides the thumb again on pointer leave", () => {
    renderPipSeekBar({ currentTime: 0, duration: 240 });
    const rail = mockRailRect();

    act(() => {
      fireEvent.pointerEnter(rail, { pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerLeave(rail, { pointerId: 1 });
    });

    expect(screen.queryByTestId("seek-tooltip")).toBeNull();
    expect(screen.getByTestId("seek-thumb").className).toContain("opacity-0");
  });
});

describe("PipSeekBar drag", () => {
  it("commits the pressed position through onSeek", () => {
    const { onSeek } = renderPipSeekBar({ currentTime: 0, duration: 100 });
    const rail = mockRailRect();

    act(() => {
      fireEvent.pointerDown(rail, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(50);
  });

  it("does not commit on a failsafe blur (no phantom seek)", () => {
    const { onSeek } = renderPipSeekBar({ currentTime: 0, duration: 100 });
    const rail = mockRailRect();

    act(() => {
      fireEvent.pointerDown(rail, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.blur(window);
    });

    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe("PipSeekBar disabled state", () => {
  it("keeps the rail non-interactive when disabled", () => {
    renderPipSeekBar({ duration: 100, disabled: true });
    const classes = screen.getByRole("slider").className.split(" ");

    expect(classes).toContain("cursor-default");
    expect(classes).not.toContain("cursor-pointer");
    expect(classes).not.toContain("hover:h-1.5");
  });

  it("never commits a seek when disabled", () => {
    const { onSeek } = renderPipSeekBar({
      duration: 100,
      disabled: true,
    });
    const rail = mockRailRect();

    act(() => {
      fireEvent.pointerDown(rail, { clientX: 50, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(onSeek).not.toHaveBeenCalled();
  });
});
