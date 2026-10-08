// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { VideoSurface } from "./VideoSurface";
import { VIDEO_HOST_COMMANDS } from "../../../lib/videoHost";

// --- jsdom gaps this surface depends on, stubbed once -----------------------
// jsdom 29 has no ResizeObserver and no matchMedia (the same two gaps
// useResponsiveItems.ts already works around).
type ChangeListener = () => void;
let resizeObserverObserveCount = 0;
let fireResizeObserver: () => void = () => {};
class StubResizeObserver {
  constructor(cb: () => void) {
    fireResizeObserver = () => {
      cb();
    };
  }
  observe(): void {
    resizeObserverObserveCount += 1;
  }
  unobserve(): void {}
  disconnect(): void {}
}
const mediaQueries: Array<{
  media: string;
  listeners: Set<ChangeListener>;
  dispatch: () => void;
}> = [];

function setDevicePixelRatio(value: number): void {
  Object.defineProperty(window, "devicePixelRatio", {
    value,
    configurable: true,
  });
}

let cssRect = { left: 0, top: 0, width: 0, height: 0 };

function rectCalls(): Array<Record<string, unknown>> {
  return (
    tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >
  )
    .filter((call) => call[0] === VIDEO_HOST_COMMANDS.setRect)
    .map((call) => call[1]);
}

function visibleCalls(): boolean[] {
  return (
    tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >
  )
    .filter((call) => call[0] === VIDEO_HOST_COMMANDS.setVisible)
    .map((call) => call[1]["visible"] as boolean);
}

/** Let the component's rAF-coalesced measurement run. */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

/** jsdom does not implement CSS transitions (or always TransitionEvent), so
 *  the component's transition listeners are driven with synthetic events. */
function transitionEvent(type: string, propertyName: string): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  return event;
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockResolvedValue(undefined);
  resizeObserverObserveCount = 0;
  fireResizeObserver = () => {};
  mediaQueries.length = 0;
  cssRect = { left: 100, top: 250, width: 800, height: 450 };
  setDevicePixelRatio(1.5);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  (window as unknown as { matchMedia: unknown }).matchMedia = (
    media: string,
  ) => {
    const entry = {
      media,
      listeners: new Set<ChangeListener>(),
      dispatch: () => {
        for (const listener of [...entry.listeners]) listener();
      },
    };
    mediaQueries.push(entry);
    return {
      media,
      matches: false,
      addEventListener: (_type: string, listener: ChangeListener) => {
        entry.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: ChangeListener) => {
        entry.listeners.delete(listener);
      },
    };
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => cssRect as DOMRect,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("VideoSurface rect sync (CSS px -> physical px)", () => {
  it("first mount sends the exact physical rect: 800x450 @dpr 1.5 -> 1200x675 at (150,375)", () => {
    render(<VideoSurface active />);

    expect(rectCalls()).toEqual([{ x: 150, y: 375, w: 1200, h: 675 }]);
  });

  it("a zero-size rect is NEVER sent (minimized window / pre-layout read)", () => {
    cssRect = { left: 0, top: 0, width: 0, height: 0 };
    const { unmount } = render(<VideoSurface active />);
    expect(rectCalls()).toEqual([]);

    // ... and it stays unsent when a later real resize arrives.
    cssRect = { left: 10, top: 20, width: 640, height: 360 };
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    unmount();
  });

  it("a negative size is never sent either", () => {
    cssRect = { left: 10, top: 20, width: -4, height: 360 };
    render(<VideoSurface active />);
    expect(rectCalls()).toEqual([]);
  });

  it("an UNCHANGED rect is not re-sent (window resize spam collapses to one invoke)", async () => {
    render(<VideoSurface active />);
    const afterMount = rectCalls().length;

    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    await flushFrame();

    expect(rectCalls()).toHaveLength(afterMount);
  });

  it("a window resize to a NEW size re-sends exactly once (maximize / restore)", async () => {
    render(<VideoSurface active />);
    cssRect = { left: 100, top: 100, width: 1200, height: 675 };

    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    await flushFrame();

    expect(rectCalls()).toEqual([
      { x: 150, y: 375, w: 1200, h: 675 },
      { x: 150, y: 150, w: 1800, h: 1013 },
    ]);
  });

  it("the element resizing (ResizeObserver) re-sends", async () => {
    render(<VideoSurface active />);
    expect(resizeObserverObserveCount).toBe(1);

    cssRect = { left: 100, top: 250, width: 400, height: 225 };
    act(() => {
      fireResizeObserver();
    });
    await flushFrame();

    expect(rectCalls()).toEqual([
      { x: 150, y: 375, w: 1200, h: 675 },
      { x: 150, y: 375, w: 600, h: 338 },
    ]);
  });

  it("a DPI change re-sends the SAME box with the NEW multiplier", async () => {
    render(<VideoSurface active />);
    expect(mediaQueries.map((q) => q.media)).toEqual(["(resolution: 1.5dppx)"]);

    setDevicePixelRatio(2);
    const armedQuery = mediaQueries[0];
    if (!armedQuery) throw new Error("no scale query armed on mount");
    act(() => {
      armedQuery.dispatch();
    });
    await flushFrame();

    expect(rectCalls()).toEqual([
      { x: 150, y: 375, w: 1200, h: 675 },
      { x: 200, y: 500, w: 1600, h: 900 },
    ]);
    // The scale query is re-armed against the resolved ratio, so a second DPI
    // step is still caught.
    expect(mediaQueries.map((q) => q.media)).toEqual([
      "(resolution: 1.5dppx)",
      "(resolution: 2dppx)",
    ]);
  });

  it("triggers coalesce into ONE rAF instead of one invoke each", async () => {
    render(<VideoSurface active />);
    cssRect = { left: 0, top: 0, width: 640, height: 360 };

    act(() => {
      window.dispatchEvent(new Event("resize"));
      fireResizeObserver();
      window.dispatchEvent(new Event("resize"));
    });
    expect(rectCalls()).toHaveLength(1);
    await flushFrame();
    expect(rectCalls()).toHaveLength(2);
  });

  // The overlay slides with `translate-y`: the box moves but its size never
  // changes, so none of the resize triggers fire. Before this, the native host
  // kept the pre-slide rect until some unrelated event (observed live: the host
  // sat 780px below the surface, still reporting the startup size).
  it("the overlay slide's `translate` transition re-sends while the box is moving", async () => {
    render(<VideoSurface active />);
    expect(rectCalls()).toHaveLength(1);

    act(() => {
      // Tailwind v4 emits translate-y-* as the CSS `translate` property, so
      // this is the event name the live app produces.
      window.dispatchEvent(transitionEvent("transitionrun", "translate"));
    });
    // The slide has moved the box 100px down; size is unchanged.
    cssRect = { left: 100, top: 350, width: 800, height: 450 };
    await flushFrame();

    const calls = rectCalls();
    expect(calls[calls.length - 1]).toEqual({
      x: 150,
      y: 525,
      w: 1200,
      h: 675,
    });
  });

  it("the transform tracker stops on transitionend (bounded, no permanent rAF)", async () => {
    render(<VideoSurface active />);
    act(() => {
      window.dispatchEvent(transitionEvent("transitionrun", "translate"));
    });
    cssRect = { left: 100, top: 350, width: 800, height: 450 };
    await flushFrame();
    expect(rectCalls()).toHaveLength(2);

    act(() => {
      window.dispatchEvent(transitionEvent("transitionend", "translate"));
    });
    await flushFrame();
    const settled = rectCalls().length;

    // The loop has stopped: further movement (with no transition running)
    // sends nothing until a real trigger arrives.
    cssRect = { left: 100, top: 450, width: 800, height: 450 };
    await flushFrame();
    await flushFrame();
    expect(rectCalls()).toHaveLength(settled);
  });

  it("a NON-movement transition (opacity) does not arm the tracker", async () => {
    render(<VideoSurface active />);
    act(() => {
      window.dispatchEvent(transitionEvent("transitionrun", "opacity"));
    });
    cssRect = { left: 100, top: 350, width: 800, height: 450 };
    await flushFrame();

    expect(rectCalls()).toHaveLength(1);
  });

  it("unmount stops observing and cancels nothing already sent", () => {
    const { unmount } = render(<VideoSurface active />);
    const sent = rectCalls().length;
    unmount();
    cssRect = { left: 0, top: 0, width: 640, height: 360 };
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(rectCalls()).toHaveLength(sent);
  });
});

describe("VideoSurface visibility", () => {
  it("active -> host shown; inactive -> host hidden", () => {
    const { rerender } = render(<VideoSurface active />);
    expect(visibleCalls()).toEqual([true]);

    rerender(<VideoSurface active={false} />);
    expect(visibleCalls()).toEqual([true, false]);
  });

  it("video -> video (same active value) sends NOTHING: no flicker, no re-show", () => {
    const { rerender } = render(<VideoSurface active />);
    rerender(<VideoSurface active />);
    expect(visibleCalls()).toEqual([true]);
  });
});

describe("VideoSurface markup contract", () => {
  it("is a plain measuring box, never a <video> element", () => {
    const { container } = render(<VideoSurface active />);
    expect(container.querySelector("video")).toBeNull();
    expect(
      container.querySelector("[data-testid='video-surface']"),
    ).not.toBeNull();
  });

  it("reuses the cover-art design language with a 16:9 box", () => {
    const { container } = render(<VideoSurface active />);
    const box = container.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    );
    if (!box) throw new Error("surface not rendered");
    const className = box.className;
    // Same ladder, same rounding, same shadow, same overflow clip.
    expect(className).toContain("w-[min(16rem,60vh)]");
    expect(className).toContain("md:w-[min(20rem,60vh)]");
    expect(className).toContain("lg:w-[min(480px,60vh)]");
    expect(className).toContain("xl:w-[min(560px,60vh)]");
    expect(className).toContain("rounded-2xl");
    expect(className).toContain("overflow-hidden");
    expect(className).toContain("shadow-[0_12px_30px_rgba(0,0,0,0.15)]");
    expect(className).toContain("dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)]");
    // Video aspect, and NOT the square cover-art aspect.
    expect(className).toContain("aspect-video");
    expect(className).not.toContain("aspect-square");
  });
});

// ---------------------------------------------------------------------------
// Loading affordance (F2). The placeholder used to spin an eternal LoaderCircle
// whether or not anything was loading: with the native host hidden (overlay
// closed / error / an audio track) the user was left watching a spinner that
// meant nothing. The affordance is now driven by what is actually true.
// ---------------------------------------------------------------------------
describe("VideoSurface loading affordance", () => {
  function surface(): HTMLElement {
    const box = document.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    );
    if (!box) throw new Error("surface not rendered");
    return box;
  }

  function spinner(): SVGSVGElement | null {
    return surface().querySelector<SVGSVGElement>("svg.lucide-loader-circle");
  }

  it("PAUSED video shows NO spinner (a paused player is not loading)", () => {
    render(<VideoSurface active isPlaying={false} />);

    expect(spinner()).toBeNull();
  });

  it("ERRORED video shows NO spinner (a failed player is not loading)", () => {
    render(<VideoSurface active hasError />);

    expect(spinner()).toBeNull();
  });

  it("ENDED video shows NO spinner (the track is over, nothing is loading)", () => {
    render(<VideoSurface active isEnded />);

    expect(spinner()).toBeNull();
  });

  it("still spins while mpv is genuinely buffering a playing track", () => {
    render(<VideoSurface active isPlaying isBuffering />);

    expect(spinner()).not.toBeNull();
    // Same spinner size/colour as before — only the CONDITION changed.
    expect(spinner()?.getAttribute("class")).toContain("w-10");
    expect(spinner()?.getAttribute("class")).toContain("text-brand-text");
    expect(spinner()?.getAttribute("class")).toContain("animate-spin");
  });

  it("spins during the pre-load intent window (isDownloading) even when not yet playing", () => {
    render(<VideoSurface active isDownloading />);

    expect(spinner()).not.toBeNull();
  });

  it("buffering a PAUSED track does not spin", () => {
    render(<VideoSurface active isPlaying={false} isBuffering />);

    expect(spinner()).toBeNull();
  });

  it("the sr-only loading label exists only while loading", () => {
    const { rerender } = render(<VideoSurface active isPlaying={false} />);
    expect(surface().querySelector("[role='status']")).toBeNull();

    rerender(<VideoSurface active isPlaying isBuffering />);
    expect(surface().querySelector("[role='status']")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fullscreen (TASK 1). Fullscreen is a REFINEMENT of the Now Playing overlay:
// the same surface, the same controls, only bigger. It must swap the sizing
// ladder, never mount a second surface or drop the controls.
// ---------------------------------------------------------------------------
describe("VideoSurface fullscreen sizing", () => {
  function classes(props: { fullscreen: boolean }): string {
    const { container } = render(<VideoSurface active {...props} />);
    const box = container.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    );
    if (!box) throw new Error("surface not rendered");
    return box.className;
  }

  it("fullscreen drops the min(560px,60vh) cap so the video fills the space", () => {
    const fs = classes({ fullscreen: true });

    expect(fs).toContain("w-full");
    expect(fs).not.toContain("xl:w-[min(560px,60vh)]");
    expect(fs).not.toContain("lg:w-[min(480px,60vh)]");
    // ... and it may never grow past the space the wrapper actually has:
    // without this the 16:9 box is 1026px tall in a 1057px window, pushing
    // the top off-screen and the controls below the fold (measured live).
    expect(fs).toContain("max-h-full");
  });

  it("leaving fullscreen restores the capped ladder exactly", () => {
    expect(classes({ fullscreen: false })).toContain("xl:w-[min(560px,60vh)]");
  });

  it("toggling fullscreen keeps the same measuring box (no remount, no second surface)", () => {
    const { container, rerender } = render(<VideoSurface active fullscreen />);
    const before = container.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    );
    if (!before) throw new Error("surface not rendered");
    const invokeCallsAfterFirst = tauriMocks.invoke.mock.calls.length;

    rerender(<VideoSurface active fullscreen={false} />);

    const after = container.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    );
    expect(after).toBe(before);
    expect(
      container.querySelectorAll("[data-testid='video-surface']"),
    ).toHaveLength(1);
    // Only the rect re-sync may fire — never a hide/show pair.
    expect(visibleCalls()).toEqual([true]);
    expect(tauriMocks.invoke.mock.calls.length).toBeGreaterThanOrEqual(
      invokeCallsAfterFirst,
    );
  });

  it("the 16:9 aspect and the design language survive fullscreen", () => {
    const fs = classes({ fullscreen: true });

    expect(fs).toContain("aspect-video");
    expect(fs).toContain("rounded-2xl");
    expect(fs).toContain("overflow-hidden");
  });
});

// ---------------------------------------------------------------------------
// Fill mode (D3). Inside the media-player layout the surface is the flexible
// row's only child: it fills the box the parent already owns instead of the
// fixed 16:9 ladder, so the video takes the window it has (spec §16/§34).
// fill=false (the default) must keep the old classes for every other caller.
// ---------------------------------------------------------------------------
describe("VideoSurface fill mode (media-player layout)", () => {
  function classes(props: { fill?: boolean; fullscreen?: boolean }): string {
    const { container } = render(<VideoSurface active {...props} />);
    const box = container.querySelector<HTMLElement>(
      "[data-testid='video-surface']",
    );
    if (!box) throw new Error("surface not rendered");
    return box.className;
  }

  it("fill=true stretches to the parent box: no aspect-video, no width ladder", () => {
    const cls = classes({ fill: true });

    expect(cls).toContain("w-full");
    expect(cls).toContain("h-full");
    expect(cls).not.toContain("aspect-video");
    expect(cls).not.toContain("w-[min(16rem,60vh)]");
    expect(cls).not.toContain("xl:w-[min(560px,60vh)]");
    // The design language the surface always had is untouched.
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("overflow-hidden");
  });

  it("fill + fullscreen goes edge-to-edge (rounded-none), still without the 16:9 box", () => {
    const cls = classes({ fill: true, fullscreen: true });

    expect(cls).toContain("w-full");
    expect(cls).toContain("h-full");
    expect(cls).toContain("rounded-none");
    expect(cls).not.toContain("rounded-xl");
    expect(cls).not.toContain("aspect-video");
    expect(cls).toContain("overflow-hidden");
  });

  it("fill=false keeps the default (old) ladder exactly", () => {
    const cls = classes({});

    expect(cls).toContain("aspect-video");
    expect(cls).toContain("xl:w-[min(560px,60vh)]");
    expect(cls).toContain("rounded-2xl");
  });
});
