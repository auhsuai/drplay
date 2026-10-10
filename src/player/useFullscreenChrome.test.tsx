// @vitest-environment jsdom
/**
 * The ONE owner of the fullscreen player-bar visibility policy: a single
 * 3000ms auto-hide timer that only runs in fullscreen, is suspended while a
 * menu is open, coalesces mousemove through one rAF and leaves no timer or
 * listener behind on exit / unmount.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FULLSCREEN_CHROME_HIDE_MS,
  useFullscreenChrome,
} from "./useFullscreenChrome";

/** rAF is faked explicitly: the hook coalesces pointer activity through it, and
 *  vitest's default fake-timer list does not include it. */
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

/**
 * The harness exposes the hook through the DOM instead of a module-level
 * variable: `data-visible` is the observable contract, and the two buttons are
 * how a test drives `revealChrome` / `setMenuOpen` exactly as the real callers
 * do (an event prop and the command context).
 */
function Harness({ isFullscreen }: { isFullscreen: boolean }) {
  const { chromeVisible, revealChrome, setMenuOpen } = useFullscreenChrome({
    isFullscreen,
  });
  return (
    <div data-testid="chrome" data-visible={String(chromeVisible)}>
      <button
        type="button"
        data-testid="reveal"
        onClick={revealChrome}
        onPointerMove={revealChrome}
      />
      <button
        type="button"
        data-testid="menu"
        onClick={() => {
          setMenuOpen(true);
        }}
      />
      <button
        type="button"
        data-testid="menu-close"
        onClick={() => {
          setMenuOpen(false);
        }}
      />
    </div>
  );
}

function click(id: string): void {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`${id} button not rendered`);
  fireEvent.click(el);
}

function visible(): boolean {
  return (
    document
      .querySelector("[data-testid='chrome']")
      ?.getAttribute("data-visible") === "true"
  );
}

function renderHarness(isFullscreen: boolean) {
  const view = render(<Harness isFullscreen={isFullscreen} />);
  if (!isFullscreen) return view;
  act(() => {
    view.rerender(<Harness isFullscreen />);
  });
  return view;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function frame(): void {
  advance(16);
}

function pointerMove(): void {
  act(() => {
    window.dispatchEvent(new Event("pointermove"));
  });
}

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
  // Spies on window APIs MUST be restored: a spy captures the rAF of the fake
  // timer instance that existed when it was created, so a leaked one silently
  // swallows the next test's frames.
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useFullscreenChrome: enter / auto-hide", () => {
  it("entering fullscreen shows the chrome, and 3000ms of no activity hides it", () => {
    const { rerender } = renderHarness(false);
    expect(visible()).toBe(true);

    rerender(<Harness isFullscreen />);
    expect(visible()).toBe(true);

    advance(FULLSCREEN_CHROME_HIDE_MS - 1);
    expect(visible()).toBe(true);

    advance(1);
    expect(visible()).toBe(false);
  });

  it("uses a 3000ms constant", () => {
    expect(FULLSCREEN_CHROME_HIDE_MS).toBe(3000);
  });

  it("never auto-hides outside fullscreen (windowed layout is unchanged)", () => {
    renderHarness(false);

    advance(FULLSCREEN_CHROME_HIDE_MS * 10);

    expect(visible()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useFullscreenChrome: activity reveal", () => {
  it("pointer movement while hidden reveals it immediately and restarts the countdown", () => {
    const { rerender } = renderHarness(false);
    rerender(<Harness isFullscreen />);
    advance(FULLSCREEN_CHROME_HIDE_MS);
    expect(visible()).toBe(false);

    pointerMove();
    frame();
    expect(visible()).toBe(true);

    // The countdown restarted from the reveal, not from the original entry:
    // a full window past the original deadline it is still painted. (Slack on
    // both sides absorbs the rAF frame the reveal is coalesced through.)
    advance(FULLSCREEN_CHROME_HIDE_MS - 500);
    expect(visible()).toBe(true);
    advance(1000);
    expect(visible()).toBe(false);
  });

  it("coalesces a mouse sweep into at most one state update per frame", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const { rerender } = renderHarness(false);
    rerender(<Harness isFullscreen />);

    for (let i = 0; i < 50; i++) pointerMove();
    frame();

    // 50 pointermove events -> ONE queued animation frame.
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it("a click on the surface reveals the chrome", () => {
    const { rerender } = renderHarness(false);
    rerender(<Harness isFullscreen />);
    advance(FULLSCREEN_CHROME_HIDE_MS);
    expect(visible()).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    frame();

    expect(visible()).toBe(true);
  });

  it("does not attach a pointer listener at all outside fullscreen", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const { rerender } = renderHarness(false);

    const pointerListeners = () =>
      addSpy.mock.calls.filter(
        ([type]) => type === "pointermove" || type === "pointerdown",
      ).length;

    expect(pointerListeners()).toBe(0);

    rerender(<Harness isFullscreen />);
    expect(pointerListeners()).toBe(2);
  });
});

describe("useFullscreenChrome: menus suspend the hide", () => {
  it("an open menu suspends the countdown; closing it resumes with a fresh 3000ms", () => {
    const { rerender } = renderHarness(false);
    rerender(<Harness isFullscreen />);

    click("menu");
    advance(FULLSCREEN_CHROME_HIDE_MS * 5);
    expect(visible()).toBe(true);

    click("menu-close");
    advance(FULLSCREEN_CHROME_HIDE_MS - 500);
    expect(visible()).toBe(true);
    advance(1000);
    expect(visible()).toBe(false);
  });
});

describe("useFullscreenChrome: leaving fullscreen", () => {
  it("clears visibility state and cancels the timer (no timer fires afterwards)", () => {
    const { rerender } = renderHarness(false);
    rerender(<Harness isFullscreen />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    rerender(<Harness isFullscreen={false} />);
    expect(visible()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    advance(FULLSCREEN_CHROME_HIDE_MS * 10);
    expect(visible()).toBe(true);
  });

  it("repeated enter/exit accumulates neither listeners nor timers", () => {
    const isPointer = (call: unknown[]) =>
      call[0] === "pointermove" || call[0] === "pointerdown";
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { rerender } = renderHarness(false);
    // Baseline: the windowed mode attaches none of our own, so anything counted
    // from here on belongs to the fullscreen cycles (React itself may register
    // its own delegated listeners, hence the relative count).
    const baselineAdds = addSpy.mock.calls.filter(isPointer).length;

    for (let i = 0; i < 5; i++) {
      rerender(<Harness isFullscreen />);
      advance(500);
      rerender(<Harness isFullscreen={false} />);
    }

    const pointerAdds =
      addSpy.mock.calls.filter(isPointer).length - baselineAdds;
    const pointerRemoves = removeSpy.mock.calls.filter(isPointer).length;

    // 5 cycles x 2 listeners, and every one of them released again.
    expect(pointerAdds).toBe(10);
    expect(pointerRemoves).toBeGreaterThanOrEqual(pointerAdds);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmount leaves no pending timer", () => {
    const { unmount } = renderHarness(false);
    act(() => {
      void 0;
    });
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
