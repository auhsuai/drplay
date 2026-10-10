// @vitest-environment jsdom
/**
 * Real window fullscreen: React state -> the OS window, and window -> React
 * state (Esc / F11 / OS-chrome exits). Tauri v2 exposes NO fullscreen-changed
 * event, so the sync back re-reads `isFullscreen()` on the window events that
 * an actual fullscreen transition produces (resize, focus, scale).
 */
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showErrorToast } from "../utils/simpleToast";
import {
  applyWindowFullscreen,
  syncWindowFullscreenState,
} from "./windowFullscreen";

/** A window event registration: takes a handler, returns an UnlistenFn. */
type Subscribe = (handler: () => void) => Promise<() => void>;

/** An UnlistenFn stand-in: `vi.fn()` is a valid `() => void`, but the mock's
 *  generic inference widens it, hence the explicit local. */
function unlisten(): () => void {
  return vi.fn();
}

const win = vi.hoisted(() => ({
  setFullscreen: vi.fn<(fullscreen: boolean) => Promise<void>>(),
  isFullscreen: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn<Subscribe>(),
  onFocusChanged: vi.fn<Subscribe>(),
  onScaleChanged: vi.fn<Subscribe>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
}));

vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

beforeEach(() => {
  win.setFullscreen.mockReset().mockResolvedValue(undefined);
  win.isFullscreen.mockReset().mockResolvedValue(false);
  win.onResized.mockReset().mockResolvedValue(() => {});
  win.onFocusChanged.mockReset().mockResolvedValue(() => {});
  win.onScaleChanged.mockReset().mockResolvedValue(() => {});
  vi.mocked(showErrorToast).mockClear();
});

afterEach(cleanup);

describe("applyWindowFullscreen", () => {
  it("enters and leaves real window fullscreen", async () => {
    await act(async () => {
      await applyWindowFullscreen(true);
      await applyWindowFullscreen(false);
    });

    expect(win.setFullscreen).toHaveBeenNthCalledWith(1, true);
    expect(win.setFullscreen).toHaveBeenNthCalledWith(2, false);
  });

  it("surfaces a denied / failed fullscreen call as a toast instead of crashing", async () => {
    win.setFullscreen.mockRejectedValueOnce(new Error("not allowed"));

    await expect(applyWindowFullscreen(true)).resolves.toBe(false);

    // Surfaced to the user (not swallowed): the toast names the failed action.
    expect(showErrorToast).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(showErrorToast).mock.calls[0]?.[0])).toMatch(
      /fullscreen/i,
    );
  });
});

describe("syncWindowFullscreenState", () => {
  it("reports a change the user made outside React (Esc / F11)", async () => {
    // Windowed at start (the common case), then the user hits F11: the resize
    // handler re-reads the window and the flip reaches React.
    win.isFullscreen.mockResolvedValue(false);
    let resizeHandler: (() => void) | null = null;
    win.onResized.mockImplementation((handler) => {
      resizeHandler = handler;
      return Promise.resolve(unlisten());
    });
    const onChange = vi.fn();

    const dispose = await syncWindowFullscreenState(onChange);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith(false);

    win.isFullscreen.mockResolvedValue(true);
    await act(async () => {
      resizeHandler?.();
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("reports the first read, then stays quiet while the window state is unchanged", async () => {
    win.isFullscreen.mockResolvedValue(false);
    const onChange = vi.fn();
    // Capture the resize handler so the test can fire a real window event.
    let resizeHandler: (() => void) | null = null;
    win.onResized.mockImplementation((handler) => {
      resizeHandler = handler;
      return Promise.resolve(unlisten());
    });

    const dispose = await syncWindowFullscreenState(onChange);
    await act(async () => {
      await Promise.resolve();
    });
    // The initial read always reports (it catches a session that was restored
    // into fullscreen); a later identical read is dropped.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);

    await act(async () => {
      resizeHandler?.();
      await Promise.resolve();
    });
    // Same state -> no second report, so a resize storm cannot re-render the
    // owner.
    expect(onChange).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("unsubscribes every listener on dispose (no leak after exit)", async () => {
    const stopListening = vi.fn();
    win.onResized.mockResolvedValue(stopListening);
    win.onFocusChanged.mockResolvedValue(stopListening);
    win.onScaleChanged.mockResolvedValue(stopListening);

    const dispose = await syncWindowFullscreenState(vi.fn());
    dispose();

    expect(stopListening).toHaveBeenCalledTimes(3);
  });
});
