// @vitest-environment jsdom
// Behavior contract for usePipSeekDrag: the PiP seek bar has no audio engine,
// so the drag hook is a mirror of useSeekDrag that commits through a callback.
// Every guarantee the original hook makes (single-owner drag, failsafe clears
// that never commit, one commit per session, zero post-unmount work) must hold
// here too, otherwise the PiP bar can strand itself mid-drag.
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePipSeekDrag, type UsePipSeekDragOptions } from "./usePipSeekDrag";

const { captureErrorMock } = vi.hoisted(() => ({
  // Typed with the real entry shape so `mock.calls[0][0]` is inspectable
  // without a cast; the implementation itself ignores the entry.
  captureErrorMock: vi.fn<
    (entry: { level: string; source: string; message: string }) => Promise<void>
  >(() => Promise.resolve()),
}));
vi.mock("../../utils/errorLog", () => ({ captureError: captureErrorMock }));

const BAR_WIDTH_PX = 200;
const DURATION_S = 100;

function makeRect(width: number): DOMRect {
  return {
    left: 0,
    right: width,
    top: 0,
    bottom: 10,
    width,
    height: 10,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  };
}

function createBarElement(width = BAR_WIDTH_PX): {
  el: HTMLDivElement;
  setPointerCapture: ReturnType<typeof vi.fn<(pointerId: number) => void>>;
} {
  const el = document.createElement("div");
  // jsdom implements neither capture method; the hook must call
  // setPointerCapture inside a try/catch, so a spy is needed to assert the
  // happy path. The spy is returned BY VALUE: referencing `el.setPointerCapture`
  // directly in an assertion trips @typescript-eslint/unbound-method.
  const setPointerCapture = vi.fn<(pointerId: number) => void>();
  el.setPointerCapture = setPointerCapture;
  el.getBoundingClientRect = () => makeRect(width);
  return { el, setPointerCapture };
}

function renderPipDragHook(
  overrides: Partial<UsePipSeekDragOptions> = {},
  barWidth = BAR_WIDTH_PX,
) {
  // Refs are created ONCE and shared across renders, exactly like the useRef
  // instances the real component passes in: a fresh object per render would
  // re-run the hook's [progressBarRef] unmount effect mid-test.
  const bar = createBarElement(barWidth);
  const options: UsePipSeekDragOptions = {
    progressBarRef: { current: bar.el },
    playheadRef: { current: 0 },
    durationRef: { current: DURATION_S },
    isDraggingRef: { current: false },
    duration: DURATION_S,
    disabled: false,
    onDraftTime: vi.fn<(time: number) => void>(),
    onCommit: vi.fn<(time: number) => void>(),
    ...overrides,
  };
  const hook = renderHook(() => usePipSeekDrag(options));
  return {
    hook,
    options,
    barEl: bar.el,
    setPointerCapture: bar.setPointerCapture,
  };
}

function pointerDown(
  hook: ReturnType<typeof renderPipDragHook>["hook"],
  props: { pointerId?: number; clientX?: number } = {},
) {
  act(() => {
    hook.result.current.handlePointerDown({
      pointerId: 1,
      clientX: 50,
      ...props,
    } as unknown as ReactPointerEvent<HTMLDivElement>);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  captureErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePipSeekDrag pointerdown guards", () => {
  it("is a no-op when duration is 0 (no drag state, no listeners, no draft)", () => {
    const { hook, options } = renderPipDragHook({
      duration: 0,
      durationRef: { current: 0 },
    });

    pointerDown(hook);

    expect(hook.result.current.isDragging).toBe(false);
    expect(options.isDraggingRef.current).toBe(false);
    expect(options.onDraftTime).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a no-op when duration is negative or NaN", () => {
    for (const duration of [-5, Number.NaN]) {
      const { hook, options } = renderPipDragHook({ duration });
      pointerDown(hook);
      expect(hook.result.current.isDragging).toBe(false);
      expect(options.onDraftTime).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("is a no-op when disabled (ended/errored surface)", () => {
    const { hook, options } = renderPipDragHook({ disabled: true });

    pointerDown(hook);

    expect(hook.result.current.isDragging).toBe(false);
    expect(options.onDraftTime).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a second pointerdown while a drag is owned (single-owner contract)", () => {
    const { hook, options } = renderPipDragHook();

    pointerDown(hook, { pointerId: 1, clientX: 50 });
    pointerDown(hook, { pointerId: 2, clientX: 150 });

    // Only the owning pointer produced a draft, and only one failsafe timer
    // exists — a second listener set would have armed a second one.
    expect(options.onDraftTime).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      fireEvent.pointerUp(window, { clientX: 150, pointerId: 2 });
    });
    expect(options.onCommit).not.toHaveBeenCalled();

    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(options.onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("usePipSeekDrag drag session", () => {
  it("captures the pointer, drafts the pressed position and arms the hard timeout", () => {
    const { hook, options, setPointerCapture } = renderPipDragHook();

    pointerDown(hook, { clientX: 50 });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    // 50 / 200 px of a 100s track.
    expect(options.onDraftTime).toHaveBeenCalledWith(25);
    expect(options.playheadRef.current).toBe(25);
    expect(hook.result.current.isDragging).toBe(true);
    expect(options.isDraggingRef.current).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reports a capture failure instead of swallowing it", () => {
    const { hook, options, barEl } = renderPipDragHook();
    Object.defineProperty(barEl, "setPointerCapture", {
      value: () => {
        throw new Error("not supported");
      },
      configurable: true,
    });

    pointerDown(hook);

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    const call = captureErrorMock.mock.calls[0]?.[0] as
      { level: string; source: string; message: string } | undefined;
    expect(call?.level).toBe("warn");
    expect(call?.message).toContain("set-pointer-capture-failed");
    // The drag itself still starts: capture is an optimization, not a gate.
    expect(options.onDraftTime).toHaveBeenCalledWith(25);
    expect(hook.result.current.isDragging).toBe(true);
  });

  it("ignores pointermove from a pointer that does not own the drag", () => {
    const { hook, options } = renderPipDragHook();

    pointerDown(hook, { pointerId: 1 });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 180, pointerId: 7 });
    });

    expect(options.onDraftTime).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    });
    expect(options.onDraftTime).toHaveBeenLastCalledWith(50);
  });

  it("re-arms the hard timeout on every owning move", () => {
    const { hook, options } = renderPipDragHook();

    pointerDown(hook);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 80, pointerId: 1 });
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // 3s elapsed but no 2s gap without a move, so the session is still live.
    expect(hook.result.current.isDragging).toBe(true);
    expect(options.onCommit).not.toHaveBeenCalled();
  });

  it("commits exactly once on pointerup and clears the drag after the release delay", () => {
    const { hook, options } = renderPipDragHook();

    pointerDown(hook, { clientX: 50 });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 180, pointerId: 1 });
    });

    expect(options.onCommit).toHaveBeenCalledTimes(1);
    expect(options.onCommit).toHaveBeenCalledWith(50);
    // Still guarded during the stale-event window so a trailing pip-state
    // cannot jump the thumb back.
    expect(hook.result.current.isDragging).toBe(true);
    expect(options.isDraggingRef.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(hook.result.current.isDragging).toBe(false);
    expect(options.isDraggingRef.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("commits once on pointercancel", () => {
    const { hook, options } = renderPipDragHook();

    pointerDown(hook, { clientX: 50 });
    act(() => {
      fireEvent.pointerCancel(window, { clientX: 100, pointerId: 1 });
    });

    expect(options.onCommit).toHaveBeenCalledTimes(1);
    expect(options.onCommit).toHaveBeenCalledWith(50);
  });

  it("does not commit when the measured rail has no width", () => {
    const { hook, options } = renderPipDragHook({}, 0);

    pointerDown(hook, { clientX: 50 });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(options.onCommit).not.toHaveBeenCalled();
  });
});

describe("usePipSeekDrag failsafes never commit", () => {
  it("window blur drops the drag immediately without committing", () => {
    const { hook, options } = renderPipDragHook();

    pointerDown(hook);
    act(() => {
      fireEvent.blur(window);
    });

    expect(options.onCommit).not.toHaveBeenCalled();
    expect(hook.result.current.isDragging).toBe(false);
    expect(options.isDraggingRef.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lostpointercapture drops the drag immediately without committing", () => {
    const { hook, options, barEl } = renderPipDragHook();

    pointerDown(hook);
    act(() => {
      barEl.dispatchEvent(new Event("lostpointercapture"));
    });

    expect(options.onCommit).not.toHaveBeenCalled();
    expect(hook.result.current.isDragging).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the 2s hard timeout clears a silent drag without committing", () => {
    const { hook, options } = renderPipDragHook();

    pointerDown(hook);
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(options.onCommit).not.toHaveBeenCalled();
    expect(hook.result.current.isDragging).toBe(false);
    expect(options.isDraggingRef.current).toBe(false);
  });

  it("a trailing pointerup after a failsafe does not commit", () => {
    const { hook, options } = renderPipDragHook();

    pointerDown(hook);
    act(() => {
      fireEvent.blur(window);
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });

    expect(options.onCommit).not.toHaveBeenCalled();
  });
});

describe("usePipSeekDrag teardown", () => {
  it("removes every window listener and timer when unmounting mid-drag", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { hook, options } = renderPipDragHook();

    pointerDown(hook);
    expect(vi.getTimerCount()).toBe(1);

    removeSpy.mockClear();
    act(() => {
      hook.unmount();
    });

    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith(
      "pointercancel",
      expect.any(Function),
    );
    expect(removeSpy).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(options.onCommit).not.toHaveBeenCalled();
  });

  it("clears the pending 150ms release timer on unmount", () => {
    const { hook } = renderPipDragHook();

    pointerDown(hook);
    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    expect(vi.getTimerCount()).toBe(1); // release-delay window armed

    act(() => {
      hook.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
