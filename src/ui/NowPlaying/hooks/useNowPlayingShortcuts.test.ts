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

describe("useNowPlayingShortcuts", () => {
  it("calls onClose once on Escape when open", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: true, onClose, onToggle });
    });
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("does nothing on Escape when closed", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: false, onClose, onToggle });
    });
    pressKey("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("calls onToggle on f when closed", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: false, onClose, onToggle });
    });
    pressKey("f");
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onToggle on f when open", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: true, onClose, onToggle });
    });
    pressKey("f");
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("toggles on uppercase F (case-insensitive)", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: false, onClose, onToggle });
    });
    pressKey("F");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("ignores f while focus is inside an input", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: false, onClose, onToggle });
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    pressKey("f");
    expect(onToggle).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape while focus is inside an input", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: true, onClose, onToggle });
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    pressKey("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("ignores Ctrl+F and does not preventDefault (search keeps working)", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: false, onClose, onToggle });
    });
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true });
    const preventSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(onToggle).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(preventSpy).not.toHaveBeenCalled();
  });

  it("ignores repeated f keydown (e.repeat)", () => {
    const onClose = vi.fn();
    const onToggle = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: false, onClose, onToggle });
    });
    pressKey("f", { repeat: true });
    expect(onToggle).not.toHaveBeenCalled();
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
    const onToggle = vi.fn();
    const onExitFullscreen = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({
        isOpen: true,
        onClose,
        onToggle,
        isFullscreen: true,
        onExitFullscreen,
      });
    });
    pressKey("Escape");
    expect(onExitFullscreen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("Escape outside fullscreen closes the overlay (unchanged behaviour)", () => {
    const onClose = vi.fn();
    const onExitFullscreen = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({
        isOpen: true,
        onClose,
        onToggle: vi.fn(),
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
        onToggle: vi.fn(),
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

  it("f in fullscreen still toggles the overlay (not stolen by the new layer)", () => {
    const onToggle = vi.fn();
    const onExitFullscreen = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({
        isOpen: true,
        onClose: vi.fn(),
        onToggle,
        isFullscreen: true,
        onExitFullscreen,
      });
    });
    pressKey("f");
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onExitFullscreen).not.toHaveBeenCalled();
  });

  it("omitting the fullscreen options keeps the original two-arg contract", () => {
    const onClose = vi.fn();
    renderHook(() => {
      useNowPlayingShortcuts({ isOpen: true, onClose, onToggle: vi.fn() });
    });
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
