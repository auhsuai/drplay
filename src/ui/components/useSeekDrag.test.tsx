// @vitest-environment jsdom
// Timer-hygiene lock for useSeekDrag: the 150ms release-delay timer armed by
// commit() must not survive unmount (no setState / stale work after teardown).
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioController } from "../../lib/AudioController";
import { useSeekDrag } from "./useSeekDrag";

vi.mock("../../utils/bufferedRange", () => ({ updateBufferBar: vi.fn() }));
vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn(() => Promise.resolve()),
}));

function nullRef<T>(): RefObject<T | null> {
  return { current: null };
}

function renderDragHook() {
  // Refs are stable across renders, exactly like the useRef instances the real
  // SeekBar passes in — a fresh object per render would re-run the hook's
  // [progressBarRef] unmount effect mid-test and invalidate the session.
  const refs = {
    progressBarRef: {
      current: document.createElement("div"),
    } as RefObject<HTMLDivElement | null>,
    progressFillRef: nullRef<HTMLDivElement>(),
    currentTimeTextRef: nullRef<HTMLSpanElement>(),
    bufferFillRef: nullRef<HTMLDivElement>(),
    playheadRef: { current: 0 },
    durationRef: { current: 100 },
    isDraggingRef: { current: false },
  };
  const audio = {
    getCurrentTime: () => 0,
    getBuffered: () => ({
      duration: 100,
      currentTime: 0,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    }),
    seek: vi.fn(),
  } as unknown as AudioController;
  const hook = renderHook(() =>
    useSeekDrag({
      audio,
      ...refs,
      duration: 100,
      setFillWidth: vi.fn(),
    }),
  );
  return { hook };
}

describe("useSeekDrag timer hygiene", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the pending 150ms release-delay timer on unmount", () => {
    const { hook } = renderDragHook();

    act(() => {
      hook.result.current.handlePointerDown({
        pointerId: 1,
        clientX: 50,
      } as unknown as ReactPointerEvent<HTMLDivElement>);
    });
    expect(vi.getTimerCount()).toBe(1); // 2s hard failsafe armed

    act(() => {
      fireEvent.pointerUp(window, { clientX: 100, pointerId: 1 });
    });
    // Commit cleared the hard failsafe and armed the release-delay window.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      hook.unmount();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
