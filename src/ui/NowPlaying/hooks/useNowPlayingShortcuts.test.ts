// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNowPlayingShortcuts } from "./useNowPlayingShortcuts";

function pressKey(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("useNowPlayingShortcuts (Escape layering only)", () => {
  it("calls onClose once on Escape when open", () => {
    const onClose = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: true, onClose });
    });
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Escape when closed", () => {
    const onClose = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: false, onClose });
    });
    pressKey("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape while focus is inside an input", () => {
    const onClose = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: true, onClose });
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    pressKey("Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not touch f/F (owned by the player command registry now)", () => {
    const onClose = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: true, onClose });
    });
    pressKey("f");
    pressKey("F");
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Escape is the universal "step back" key and the app already owns it here
// (one hook, one place). Fullscreen inserts a level between the overlay and
// the app, so Escape must peel ONE level at a time: fullscreen -> overlay ->
// nothing. It must not close the whole surface on the first press.
describe("useNowPlayingShortcuts fullscreen layer (TASK 1)", () => {
  it("Escape in fullscreen exits fullscreen and does NOT close the overlay", () => {
    const onClose = vi.fn();
    const onExitFullscreen = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({
        isOpen: true,
        onClose,
        isFullscreen: true,
        onExitFullscreen,
      });
    });
    pressKey("Escape");
    expect(onExitFullscreen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape outside fullscreen closes the overlay (unchanged behaviour)", () => {
    const onClose = vi.fn();
    const onExitFullscreen = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({
        isOpen: true,
        onClose,
        isFullscreen: false,
        onExitFullscreen,
      });
    });
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onExitFullscreen).not.toHaveBeenCalled();
  });

  it("Escape in fullscreen is IGNORED while a text field has focus", () => {
    const onClose = vi.fn();
    const onExitFullscreen = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({
        isOpen: true,
        onClose,
        isFullscreen: true,
        onExitFullscreen,
      });
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    pressKey("Escape");
    expect(onExitFullscreen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("omitting the fullscreen options keeps the original two-arg contract", () => {
    const onClose = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: true, onClose });
    });
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
