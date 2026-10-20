// @vitest-environment jsdom
/**
 * Cursor auto-hide for the NowPlaying video overlay: hides the OS cursor after
 * CURSOR_IDLE_HIDE_MS of inactivity, reveals on pointer/keyboard activity,
 * suspends while a menu/dialog is open, and restores visibility on close/blur.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_IDLE_HIDE_MS, useAutoHideCursor } from "./useAutoHideCursor";

type FakeMethod =
  | "setTimeout"
  | "clearTimeout"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
  | "Date";

const FAKE_TIMERS: { toFake: FakeMethod[] } = {
  toFake: [
    "setTimeout",
    "clearTimeout",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "Date",
  ],
};

const win = vi.hoisted(() => ({
  setCursorVisible: vi
    .fn<(visible: boolean) => Promise<void>>()
    .mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

function Harness({
  enabled,
  suspended,
}: {
  enabled: boolean;
  suspended: boolean;
}) {
  const { revealCursor } = useAutoHideCursor({ enabled, suspended });
  return (
    <div>
      <button data-testid="reveal" onClick={revealCursor} />
    </div>
  );
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function frame(): void {
  advance(16);
}

beforeEach(() => {
  win.setCursorVisible.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers(FAKE_TIMERS);
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useAutoHideCursor: enable / auto-hide", () => {
  it("hides the cursor after CURSOR_IDLE_HIDE_MS with no activity", () => {
    render(<Harness enabled suspended={false} />);
    advance(CURSOR_IDLE_HIDE_MS - 1);
    expect(win.setCursorVisible).not.toHaveBeenCalledWith(false);
    advance(1);
    expect(win.setCursorVisible).toHaveBeenCalledWith(false);
  });

  it("uses a 1500ms constant", () => {
    expect(CURSOR_IDLE_HIDE_MS).toBe(1500);
  });

  it("does nothing when disabled", () => {
    render(<Harness enabled={false} suspended={false} />);
    advance(CURSOR_IDLE_HIDE_MS * 10);
    expect(win.setCursorVisible).not.toHaveBeenCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useAutoHideCursor: activity reveal", () => {
  it("pointer movement reveals and restarts the countdown", () => {
    render(<Harness enabled suspended={false} />);
    advance(CURSOR_IDLE_HIDE_MS);
    expect(win.setCursorVisible).toHaveBeenCalledWith(false);

    act(() => {
      window.dispatchEvent(new Event("pointermove"));
    });
    frame();
    expect(win.setCursorVisible).toHaveBeenLastCalledWith(true);

    advance(CURSOR_IDLE_HIDE_MS - 500);
    expect(win.setCursorVisible).not.toHaveBeenLastCalledWith(false);
    advance(1000);
    expect(win.setCursorVisible).toHaveBeenLastCalledWith(false);
  });

  it("coalesces a pointer sweep into one rAF", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    render(<Harness enabled suspended={false} />);
    for (let i = 0; i < 50; i++) {
      act(() => {
        window.dispatchEvent(new Event("pointermove"));
      });
    }
    frame();
    expect(rafSpy).toHaveBeenCalled();
    // At most one queued frame for the whole sweep.
    expect(rafSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("pointerdown reveals the cursor", () => {
    render(<Harness enabled suspended={false} />);
    advance(CURSOR_IDLE_HIDE_MS);
    expect(win.setCursorVisible).toHaveBeenCalledWith(false);

    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    frame();
    expect(win.setCursorVisible).toHaveBeenLastCalledWith(true);
  });

  it("revealCursor from the hook reveals and restarts", () => {
    render(<Harness enabled suspended={false} />);
    advance(CURSOR_IDLE_HIDE_MS);
    expect(win.setCursorVisible).toHaveBeenCalledWith(false);

    const btn = document.querySelector<HTMLButtonElement>(
      "[data-testid='reveal']",
    );
    if (!btn) throw new Error("reveal button missing");
    act(() => {
      btn.click();
    });
    expect(win.setCursorVisible).toHaveBeenLastCalledWith(true);
  });
});

describe("useAutoHideCursor: suspension", () => {
  it("suspended keeps cursor visible even after long wait", () => {
    render(<Harness enabled suspended />);
    advance(CURSOR_IDLE_HIDE_MS * 5);
    expect(win.setCursorVisible).not.toHaveBeenCalledWith(false);
  });

  it("after unsuspend, hides only after a full idle window", () => {
    const { rerender } = render(<Harness enabled suspended />);
    rerender(<Harness enabled suspended={false} />);
    advance(CURSOR_IDLE_HIDE_MS - 500);
    expect(win.setCursorVisible).not.toHaveBeenLastCalledWith(false);
    advance(1000);
    expect(win.setCursorVisible).toHaveBeenLastCalledWith(false);
  });
});

describe("useAutoHideCursor: cleanup / blur", () => {
  it("disabling restores cursor visible and clears timer", () => {
    const { rerender } = render(<Harness enabled suspended={false} />);
    advance(CURSOR_IDLE_HIDE_MS);
    expect(win.setCursorVisible).toHaveBeenCalledWith(false);

    rerender(<Harness enabled={false} suspended={false} />);
    expect(win.setCursorVisible).toHaveBeenLastCalledWith(true);
    advance(CURSOR_IDLE_HIDE_MS * 10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blur restores cursor visible and clears timer", () => {
    render(<Harness enabled suspended={false} />);
    advance(CURSOR_IDLE_HIDE_MS);
    expect(win.setCursorVisible).toHaveBeenCalledWith(false);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(win.setCursorVisible).toHaveBeenLastCalledWith(true);
    advance(CURSOR_IDLE_HIDE_MS * 10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmount leaves no pending timer", () => {
    const { unmount } = render(<Harness enabled suspended={false} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("repeated enable/disable accumulates neither listeners nor timers", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { rerender } = render(<Harness enabled suspended={false} />);
    const baselineAdds = addSpy.mock.calls.filter(
      ([type]) => type === "pointermove" || type === "pointerdown",
    ).length;

    for (let i = 0; i < 5; i++) {
      rerender(<Harness enabled={false} suspended={false} />);
      rerender(<Harness enabled suspended={false} />);
    }
    rerender(<Harness enabled={false} suspended={false} />);
    const pointerAdds =
      addSpy.mock.calls.filter(
        ([type]) => type === "pointermove" || type === "pointerdown",
      ).length - baselineAdds;
    const pointerRemoves = removeSpy.mock.calls.filter(
      ([type]) => type === "pointermove" || type === "pointerdown",
    ).length;
    expect(pointerRemoves).toBeGreaterThanOrEqual(pointerAdds);
    expect(vi.getTimerCount()).toBe(0);
  });
});
