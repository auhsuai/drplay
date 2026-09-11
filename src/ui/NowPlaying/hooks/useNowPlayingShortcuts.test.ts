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
