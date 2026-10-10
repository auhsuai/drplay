// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioController } from "../lib/AudioController";
import { usePlayerStore } from "../store/playerStore";
import {
  guardAllowsAutoAdvance,
  noteFormatError,
  resetAdvanceGuard,
} from "../utils/playerError";
import type { PlayerCommandContext } from "./commands";
import { runPlayerCommand, usePlayerCommands } from "./usePlayerCommands";

const { showErrorToast } = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
}));

vi.mock("../utils/simpleToast", () => ({
  showErrorToast,
  showSuccessToast: vi.fn(),
}));

function makeCtx(overrides: Partial<PlayerCommandContext> = {}) {
  const audio = {
    getVolume: vi.fn(() => 0.5),
    setVolume: vi.fn(),
    toggleMute: vi.fn(() => true),
    isMuted: vi.fn(() => false),
    getCurrentTime: vi.fn(() => 100),
    getDuration: vi.fn(() => 240),
    seek: vi.fn(),
    pause: vi.fn(),
  };
  const ctx: PlayerCommandContext & { _audio: typeof audio } = {
    audio: audio as unknown as AudioController,
    isFullscreen: false,
    toggleFullscreen: vi.fn(),
    toggleQueue: vi.fn(),
    isQueueOpen: false,
    selectTrack: vi.fn(),
    togglePlay: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    togglePlayMode: vi.fn(),
    setPlayMode: vi.fn(),
    ...overrides,
    _audio: audio,
  };
  return ctx;
}

function pressKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    errorInfo: null,
    playMode: "normal",
  });
  resetAdvanceGuard();
  showErrorToast.mockClear();
  document.body.innerHTML = "";
});

afterEach(() => {
  usePlayerStore.setState({ errorInfo: null, playMode: "normal" });
});

describe("usePlayerCommands", () => {
  it("wires Space to ctx.togglePlay and prevents the default action", () => {
    const ctx = makeCtx();
    renderHook(() => {
      usePlayerCommands(ctx);
    });

    const event = pressKey(" ");

    expect(ctx.togglePlay).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("wires n/p/f/Ctrl+Q/ArrowRight/m through their commands", () => {
    const ctx = makeCtx();
    renderHook(() => {
      usePlayerCommands(ctx);
    });

    pressKey("n");
    expect(ctx.next).toHaveBeenCalledTimes(1);

    pressKey("p");
    expect(ctx.previous).toHaveBeenCalledTimes(1);

    pressKey("f");
    expect(ctx.toggleFullscreen).toHaveBeenCalledTimes(1);

    pressKey("q", { ctrlKey: true });
    expect(ctx.toggleQueue).toHaveBeenCalledTimes(1);

    pressKey("ArrowRight");
    expect(ctx._audio.seek).toHaveBeenCalledWith(105);

    pressKey("m");
    expect(ctx._audio.toggleMute).toHaveBeenCalledTimes(1);
  });

  it("wires Ctrl+Shift+S to shuffle and F8 to the queue toggle", () => {
    const ctx = makeCtx();
    renderHook(() => {
      usePlayerCommands(ctx);
    });

    pressKey("s", { ctrlKey: true, shiftKey: true });
    expect(ctx.setPlayMode).toHaveBeenCalledWith("shuffle");

    pressKey("F8");
    expect(ctx.toggleQueue).toHaveBeenCalledTimes(1);
  });

  it("ignores every command while an input has focus", () => {
    const ctx = makeCtx();
    renderHook(() => {
      usePlayerCommands(ctx);
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    pressKey(" ");
    pressKey("n");
    pressKey("q", { ctrlKey: true });

    expect(ctx.togglePlay).not.toHaveBeenCalled();
    expect(ctx.next).not.toHaveBeenCalled();
    expect(ctx.toggleQueue).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount", () => {
    const ctx = makeCtx();
    const { unmount } = renderHook(() => {
      usePlayerCommands(ctx);
    });
    unmount();

    pressKey(" ");
    expect(ctx.togglePlay).not.toHaveBeenCalled();
  });

  it("always runs the freshest context (ctx change after rerender)", () => {
    const first = makeCtx();
    const second = makeCtx();
    const { rerender } = renderHook(
      ({ ctx }: { ctx: PlayerCommandContext }) => {
        usePlayerCommands(ctx);
      },
      { initialProps: { ctx: first } },
    );

    rerender({ ctx: second });
    pressKey(" ");

    expect(first.togglePlay).not.toHaveBeenCalled();
    expect(second.togglePlay).toHaveBeenCalledTimes(1);
  });

  it("surfaces a command failure as an error toast instead of swallowing it", async () => {
    const ctx = makeCtx();
    ctx.next = vi.fn(() => {
      throw new Error("boom");
    });
    renderHook(() => {
      usePlayerCommands(ctx);
    });

    pressKey("n");
    await Promise.resolve();

    expect(showErrorToast).toHaveBeenCalledTimes(1);
    const message = showErrorToast.mock.calls[0]?.[0] as string;
    expect(message).toContain("boom");
  });

  it("runPlayerCommand is the shared entry point for button/menu callers", () => {
    const ctx = makeCtx();
    for (let i = 0; i < 3; i++) noteFormatError(Date.now());
    expect(guardAllowsAutoAdvance(Date.now())).toBe(false);

    runPlayerCommand("PLAYER_PLAY_PAUSE", ctx);

    expect(ctx.togglePlay).toHaveBeenCalledTimes(1);
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Slice 1 (C): a shortcut must run EXACTLY ONCE and additionally notify
// activity so the fullscreen chrome reveals. The notification rides on the
// shared `runPlayerCommand` entry point (which the keyboard path, the bar
// buttons and the menu all go through) — never a second keydown listener.
// ---------------------------------------------------------------------------
describe("player activity notification (fullscreen chrome reveal)", () => {
  it("a keyboard command runs once and notifies activity once", () => {
    const ctx = makeCtx({ onActivity: vi.fn() });
    renderHook(() => {
      usePlayerCommands(ctx);
    });

    pressKey(" ");

    expect(ctx.togglePlay).toHaveBeenCalledTimes(1);
    expect(ctx.onActivity).toHaveBeenCalledTimes(1);
  });

  it("a button/menu caller notifies activity through the same entry point", () => {
    const ctx = makeCtx({ onActivity: vi.fn() });

    runPlayerCommand("PLAYER_PLAY_PAUSE", ctx);

    expect(ctx.togglePlay).toHaveBeenCalledTimes(1);
    expect(ctx.onActivity).toHaveBeenCalledTimes(1);
  });

  it("a key with no command does not notify", () => {
    const ctx = makeCtx({ onActivity: vi.fn() });
    renderHook(() => {
      usePlayerCommands(ctx);
    });

    pressKey("9");

    expect(ctx.onActivity).not.toHaveBeenCalled();
    expect(ctx.togglePlay).not.toHaveBeenCalled();
  });

  it("a context without the notifier still runs the command", () => {
    const ctx = makeCtx();
    renderHook(() => {
      usePlayerCommands(ctx);
    });

    expect(() => pressKey(" ")).not.toThrow();
    expect(ctx.togglePlay).toHaveBeenCalledTimes(1);
  });
});

describe("storm banner guard", () => {
  it("a manual command clears the storm banner through the shared guard reset (F8-3 parity)", () => {
    const ctx = makeCtx();
    usePlayerStore.setState({
      errorInfo: { code: "advance_stopped", message: "storm" },
    });
    for (let i = 0; i < 3; i++) noteFormatError(Date.now());
    renderHook(() => {
      usePlayerCommands(ctx);
    });

    pressKey("n");

    expect(ctx.next).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().errorInfo).toBeNull();
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);
  });
});
