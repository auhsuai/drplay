// @vitest-environment jsdom
//
// F2 regression: transport shortcuts must ignore (a) held-key auto-repeat
// (`e.repeat` — one physical press = one action, not a machine-gun) and
// (b) Ctrl/Meta/Alt chords (browser/app shortcuts like Ctrl+S must neither
// trigger the player nor get preventDefault-ed). Plain single presses keep
// working unchanged.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import type { UseKeyboardShortcutsParams } from "./useKeyboardShortcuts";

function Harness(params: UseKeyboardShortcutsParams) {
  useKeyboardShortcuts(params);
  return null;
}

function renderHarness(overrides: Partial<UseKeyboardShortcutsParams> = {}) {
  const params: UseKeyboardShortcutsParams = {
    onNextTrack: vi.fn(),
    onPrevTrack: vi.fn(),
    onTogglePlay: vi.fn(),
    onTogglePlayMode: vi.fn(),
    ...overrides,
  };
  render(<Harness {...params} />);
  return params;
}

// Dispatch a raw cancelable KeyboardEvent so `defaultPrevented` is assertable
// (jsdom only honors preventDefault on cancelable events).
function keyDown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.dispatchEvent(event);
  return event;
}

describe("useKeyboardShortcuts repeat + modifier guard (F2)", () => {
  afterEach(() => {
    cleanup();
  });

  it("ignores held-key auto-repeat (e.repeat) — one physical press fires once", () => {
    const p = renderHarness();

    fireEvent.keyDown(window, { key: "n" });
    fireEvent.keyDown(window, { key: "n", repeat: true });
    fireEvent.keyDown(window, { key: "n", repeat: true });

    expect(p.onNextTrack).toHaveBeenCalledTimes(1);
    expect(p.onPrevTrack).not.toHaveBeenCalled();

    // Same for the space toggle while held down.
    fireEvent.keyDown(window, { key: " ", repeat: true });
    expect(p.onTogglePlay).not.toHaveBeenCalled();
  });

  it("ignores Ctrl/Meta/Alt chords and does not preventDefault them", () => {
    const p = renderHarness();

    // Ctrl+S must stay the browser/app save shortcut: no playmode toggle AND
    // no preventDefault swallow.
    const ctrlS = keyDown({ key: "s", ctrlKey: true });
    expect(p.onTogglePlayMode).not.toHaveBeenCalled();
    expect(ctrlS.defaultPrevented).toBe(false);

    const metaN = keyDown({ key: "n", metaKey: true });
    expect(p.onNextTrack).not.toHaveBeenCalled();
    expect(metaN.defaultPrevented).toBe(false);

    const altP = keyDown({ key: "p", altKey: true });
    expect(p.onPrevTrack).not.toHaveBeenCalled();
    expect(altP.defaultPrevented).toBe(false);

    const altSpace = keyDown({ key: " ", altKey: true });
    expect(p.onTogglePlay).not.toHaveBeenCalled();
    expect(altSpace.defaultPrevented).toBe(false);
  });

  it("contract guard: plain single presses keep firing exactly as before", () => {
    const p = renderHarness();

    const space = keyDown({ key: " " });
    const n = keyDown({ key: "n" });
    const pKey = keyDown({ key: "p" });
    const s = keyDown({ key: "s" });

    expect(p.onTogglePlay).toHaveBeenCalledTimes(1);
    expect(p.onNextTrack).toHaveBeenCalledTimes(1);
    expect(p.onPrevTrack).toHaveBeenCalledTimes(1);
    expect(p.onTogglePlayMode).toHaveBeenCalledTimes(1);
    // Plain presses still preventDefault (scroll/quick-find suppression).
    expect(space.defaultPrevented).toBe(true);
    expect(n.defaultPrevented).toBe(true);
    expect(pKey.defaultPrevented).toBe(true);
    expect(s.defaultPrevented).toBe(true);
  });

  it("INPUT focus exclusion still wins over plain keys (unchanged contract)", () => {
    const p = renderHarness();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(window, { key: " " });

    expect(p.onTogglePlay).not.toHaveBeenCalled();
    input.remove();
  });
});
