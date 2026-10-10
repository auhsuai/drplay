// @vitest-environment jsdom
/**
 * RED tests for the React-owned video menu (Slice 2). The native Win32 popup is
 * gone: BOTH entry points (the bar's More button and right-click on the video
 * area) drive this hook, which builds the SAME menuModel tree and dispatches
 * the picked id through the existing runMenuEntry path.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerCommandContext } from "./commands";
import type { NativeMenuEntry } from "../lib/nativeMenu";

const modelMock = vi.hoisted(() => ({
  takeVideoMenuSnapshot: vi.fn(),
  buildContextMenuModel: vi.fn(),
  runMenuEntry: vi.fn(),
}));
vi.mock("./menuModel", () => modelMock);

// The native half must not be reachable from this path at all.
const nativeMenuMock = vi.hoisted(() => ({ showContextMenu: vi.fn() }));
vi.mock("../lib/nativeMenu", () => nativeMenuMock);

const toastMock = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));
vi.mock("../utils/simpleToast", () => toastMock);

import { useVideoMenu, type VideoMenuAnchor } from "./useVideoMenu";
import {
  useFullscreenChrome,
  FULLSCREEN_CHROME_HIDE_MS,
} from "./useFullscreenChrome";

function makeCtx(isFullscreen: boolean): PlayerCommandContext {
  return {
    audio: {} as PlayerCommandContext["audio"],
    isFullscreen,
    toggleFullscreen: vi.fn(),
    toggleQueue: vi.fn(),
    isQueueOpen: false,
    selectTrack: vi.fn(),
    togglePlay: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    togglePlayMode: vi.fn(),
    setPlayMode: vi.fn(),
  };
}

const snapshotFixture = {
  isPaused: false,
  isFullscreen: false,
  isMuted: false,
};

const modelFixture: NativeMenuEntry[] = [
  { kind: "item", id: "PLAYER_PLAY_PAUSE", label: "Play" },
  { kind: "separator" },
  {
    kind: "item",
    id: "menu:audio",
    label: "Audio",
    children: [{ kind: "item", id: "menu:audio:1", label: "Track 1" }],
  },
];

function makeRect(over: Partial<DOMRect> = {}): DOMRect {
  return {
    top: 100,
    right: 400,
    bottom: 140,
    left: 360,
    x: 360,
    y: 100,
    width: 40,
    height: 40,
    toJSON: () => ({}),
    ...over,
  };
}

const RECT = makeRect();

function buttonAnchor(trigger: HTMLElement | null = null): VideoMenuAnchor {
  return { kind: "button", rect: RECT, trigger };
}

/**
 * `open` kicks off the async snapshot; flushing inside act() is what lets the
 * promise resolution land before the assertions run.
 */
async function actAsync(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
    await Promise.resolve();
  });
}

beforeEach(() => {
  modelMock.takeVideoMenuSnapshot.mockReset();
  modelMock.buildContextMenuModel.mockReset();
  modelMock.runMenuEntry.mockReset();
  nativeMenuMock.showContextMenu.mockReset();
  toastMock.showErrorToast.mockReset();
  modelMock.takeVideoMenuSnapshot.mockResolvedValue(snapshotFixture);
  modelMock.buildContextMenuModel.mockReturnValue(modelFixture);
  modelMock.runMenuEntry.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useVideoMenu: one tree, two entry points", () => {
  it("right-click at a point builds the requested model and suspends the chrome", async () => {
    const onMenuOpenChange = vi.fn();
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange,
      }),
    );

    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 120, y: 240 });
    });

    await waitFor(() => {
      expect(result.current.isOpen).toBe(true);
    });
    expect(modelMock.takeVideoMenuSnapshot).toHaveBeenCalledWith(false);
    expect(modelMock.buildContextMenuModel).toHaveBeenCalledWith(
      "full",
      snapshotFixture,
    );
    expect(result.current.anchorPoint).toEqual({ x: 120, y: 240 });
    expect(result.current.buttonRect).toBeNull();
    expect(result.current.entries).toEqual(modelFixture);
    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
  });

  it("the More button anchors at the trigger rect and produces the SAME entries", async () => {
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(true),
        isFullscreen: true,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 10, y: 10 });
    });
    const fromPoint = result.current.entries;
    await actAsync(() => {
      result.current.close();
    });

    await actAsync(() => {
      result.current.open("full", buttonAnchor());
    });

    expect(result.current.buttonRect).toBe(RECT);
    expect(result.current.anchorPoint).toBeNull();
    expect(result.current.entries).toEqual(fromPoint);
    // Same section for both entry points — the model is built once per open.
    expect(modelMock.buildContextMenuModel).toHaveBeenNthCalledWith(
      2,
      "full",
      expect.anything(),
    );
    expect(nativeMenuMock.showContextMenu).not.toHaveBeenCalled();
  });

  it("re-anchoring from point to button drops the stale point (no mixed coordinates)", async () => {
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 33, y: 44 });
    });
    await actAsync(() => {
      result.current.open("full", buttonAnchor());
    });

    expect(result.current.anchorPoint).toBeNull();
    // Identity, not shape: the exact rect the caller measured is what the
    // positioning utility consumes.
    expect(result.current.buttonRect).toBe(RECT);
  });

  it("never reaches the native menu on any path", async () => {
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 1, y: 2 });
    });
    await actAsync(() => {
      result.current.select("PLAYER_PLAY_PAUSE");
    });
    await actAsync(() => {
      result.current.close();
    });

    expect(nativeMenuMock.showContextMenu).not.toHaveBeenCalled();
  });

  it("the More button is a toggle: a second click on the same trigger closes", async () => {
    const onMenuOpenChange = vi.fn();
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange,
      }),
    );

    await actAsync(() => {
      result.current.open("full", buttonAnchor());
    });
    expect(result.current.isOpen).toBe(true);
    await actAsync(() => {
      result.current.open("full", buttonAnchor());
    });

    expect(result.current.isOpen).toBe(false);
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("right-click while the button menu is open re-anchors instead of closing", async () => {
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", buttonAnchor());
    });
    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 5, y: 6 });
    });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.anchorPoint).toEqual({ x: 5, y: 6 });
    expect(result.current.buttonRect).toBeNull();
  });

  it("select dispatches through runMenuEntry exactly once with the open-time snapshot, then closes", async () => {
    const onMenuOpenChange = vi.fn();
    const ctx = makeCtx(true);
    const { result } = renderHook(() =>
      useVideoMenu({ ctx, isFullscreen: true, onMenuOpenChange }),
    );

    await actAsync(() => {
      result.current.open("full", buttonAnchor());
    });
    await actAsync(() => {
      result.current.select("menu:audio:1");
    });

    expect(modelMock.runMenuEntry).toHaveBeenCalledTimes(1);
    expect(modelMock.runMenuEntry).toHaveBeenCalledWith(
      "menu:audio:1",
      ctx,
      snapshotFixture,
    );
    expect(result.current.isOpen).toBe(false);
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("select before the snapshot resolves is a no-op (never a half-open dispatch)", async () => {
    let resolveSnapshot: ((value: unknown) => void) | undefined;
    modelMock.takeVideoMenuSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 1, y: 1 });
    });
    await actAsync(() => {
      result.current.select("PLAYER_PLAY_PAUSE");
    });

    expect(modelMock.runMenuEntry).not.toHaveBeenCalled();
    await actAsync(() => {
      resolveSnapshot?.(snapshotFixture);
    });
  });

  it("a snapshot that resolves after a close never resurrects the menu", async () => {
    let resolveSnapshot: ((value: unknown) => void) | undefined;
    modelMock.takeVideoMenuSnapshot.mockReturnValue(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 1, y: 1 });
    });
    await actAsync(() => {
      result.current.close();
    });
    await actAsync(() => {
      resolveSnapshot?.(snapshotFixture);
    });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.entries).toEqual([]);
    expect(modelMock.buildContextMenuModel).not.toHaveBeenCalled();
  });

  it("a snapshot failure surfaces as an error toast and leaves the menu closed", async () => {
    modelMock.takeVideoMenuSnapshot.mockRejectedValue(new Error("mpv gone"));
    const onMenuOpenChange = vi.fn();
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange,
      }),
    );

    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 5, y: 5 });
    });

    await waitFor(() => {
      expect(toastMock.showErrorToast).toHaveBeenCalledWith("mpv gone");
    });
    expect(result.current.isOpen).toBe(false);
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("a dispatch failure is surfaced as a toast, never an unhandled rejection", async () => {
    modelMock.runMenuEntry.mockRejectedValue(new Error("set aspect failed"));
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 5, y: 5 });
    });
    await actAsync(() => {
      result.current.select("menu:aspect:16/9");
    });

    await waitFor(() => {
      expect(toastMock.showErrorToast).toHaveBeenCalledWith(
        "set aspect failed",
      );
    });
    expect(result.current.isOpen).toBe(false);
  });

  it("focus returns to the trigger on close, but only the button path has one", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", buttonAnchor(trigger));
    });
    expect(result.current.trigger).toBe(trigger);
    await actAsync(() => {
      result.current.close();
    });
    expect(document.activeElement).toBe(trigger);

    // Right-click path: no trigger, so focus is left where the gesture put it.
    const before = document.activeElement;
    await actAsync(() => {
      result.current.open("full", { kind: "point", x: 1, y: 1 });
    });
    await actAsync(() => {
      result.current.close();
    });
    expect(document.activeElement).toBe(before);

    trigger.remove();
  });

  it("focus is NOT stolen on close when another control owns it", async () => {
    const trigger = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(trigger, other);
    const { result } = renderHook(() =>
      useVideoMenu({
        ctx: makeCtx(false),
        isFullscreen: false,
        onMenuOpenChange: vi.fn(),
      }),
    );

    await actAsync(() => {
      result.current.open("full", buttonAnchor(trigger));
    });
    other.focus();
    await actAsync(() => {
      result.current.close();
    });

    expect(document.activeElement).toBe(other);
    trigger.remove();
    other.remove();
  });
});

// ---------------------------------------------------------------------------
// Timer coordination with Slice 1's useFullscreenChrome: opening the menu
// suspends the hide, closing it restarts a FRESH 3000ms countdown, and a
// submenu keeps working past 3000ms because the menu itself is still open.
// ---------------------------------------------------------------------------
describe("useVideoMenu + useFullscreenChrome", () => {
  it("open suspends; close restarts a fresh countdown; an open submenu survives 3000ms", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx(true);
    const events: boolean[] = [];

    // One harness: App wires these two hooks together exactly like this, so the
    // suspension is exercised through the real pair rather than a mock.
    const { result } = renderHook(() => {
      const chrome = useFullscreenChrome({ isFullscreen: true });
      const menu = useVideoMenu({
        ctx,
        isFullscreen: true,
        onMenuOpenChange: (open) => {
          events.push(open);
          chrome.setMenuOpen(open);
        },
      });
      return { chrome, menu };
    });

    // Menu open -> controls revealed and NOT hidden by the inactivity timer.
    await actAsync(() => {
      result.current.menu.open("full", { kind: "point", x: 10, y: 10 });
    });
    expect(events).toEqual([true]);
    expect(result.current.chrome.chromeVisible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(FULLSCREEN_CHROME_HIDE_MS * 2);
    });
    expect(result.current.chrome.chromeVisible).toBe(true);

    // Menu open for 5s: the submenu is still usable (entries never re-read).
    expect(result.current.menu.entries).toEqual(modelFixture);
    act(() => {
      vi.advanceTimersByTime(FULLSCREEN_CHROME_HIDE_MS);
    });
    expect(result.current.menu.isOpen).toBe(true);
    expect(result.current.chrome.chromeVisible).toBe(true);

    // Close -> a FRESH full countdown, not the remainder of a stale one.
    await actAsync(() => {
      result.current.menu.close();
    });
    expect(events).toEqual([true, false]);
    act(() => {
      vi.advanceTimersByTime(FULLSCREEN_CHROME_HIDE_MS - 1);
    });
    expect(result.current.chrome.chromeVisible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.chrome.chromeVisible).toBe(false);
  });

  it("leaving fullscreen while the menu is open leaves the controls visible and no stale timer", async () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ fullscreen }: { fullscreen: boolean }) => {
        const chrome = useFullscreenChrome({ isFullscreen: fullscreen });
        const menu = useVideoMenu({
          ctx: makeCtx(fullscreen),
          isFullscreen: fullscreen,
          onMenuOpenChange: chrome.setMenuOpen,
        });
        return { chrome, menu };
      },
      { initialProps: { fullscreen: true } },
    );

    await actAsync(() => {
      result.current.menu.open("full", { kind: "point", x: 10, y: 10 });
    });
    expect(result.current.chrome.chromeVisible).toBe(true);

    rerender({ fullscreen: false });
    expect(result.current.chrome.chromeVisible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.chrome.chromeVisible).toBe(true);

    await actAsync(() => {
      result.current.menu.close();
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.chrome.chromeVisible).toBe(true);
  });
});
