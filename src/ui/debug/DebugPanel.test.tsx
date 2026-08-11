// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DebugPanel } from "./DebugPanel";
import { DEBUG_EVENTS } from "./debugEvents";

const openPanel = () => {
  fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });
};

describe("DebugPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing while closed by default", () => {
    render(<DebugPanel />);
    expect(screen.queryByText("Debug UI")).toBeNull();
  });

  it("opens on Ctrl+Shift+D and shows the panel title", () => {
    render(<DebugPanel />);
    openPanel();
    expect(screen.getByText("Debug UI")).toBeTruthy();
  });

  it("toggles closed on a second Ctrl+Shift+D", () => {
    render(<DebugPanel />);
    openPanel();
    expect(screen.getByText("Debug UI")).toBeTruthy();

    openPanel();
    expect(screen.queryByText("Debug UI")).toBeNull();
  });

  it("closes with Escape while open", () => {
    render(<DebugPanel />);
    openPanel();
    expect(screen.getByText("Debug UI")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Debug UI")).toBeNull();
  });

  it("Escape while closed keeps the panel closed", () => {
    render(<DebugPanel />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Debug UI")).toBeNull();
  });

  it("Ctrl+Shift+D works even when focus is inside an input", () => {
    render(<DebugPanel />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    openPanel();
    expect(screen.getByText("Debug UI")).toBeTruthy();
    input.remove();
  });

  it("demo rate-limit button dispatches the RATE_LIMIT debug event", () => {
    render(<DebugPanel />);
    openPanel();
    // Spy AFTER opening: fireEvent.keyDown(window, ...) itself goes through
    // window.dispatchEvent and would pollute the call count.
    const spy = vi.spyOn(window, "dispatchEvent");

    fireEvent.click(screen.getByRole("button", { name: /rate limit modal/i }));

    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe(DEBUG_EVENTS.RATE_LIMIT);
  });

  it.each([
    {
      label: "Player error: network_interrupted",
      code: "network_interrupted",
      message: "Mạng không ổn định, đang thử lại...",
    },
    {
      label: "Player error: format_error",
      code: "format_error",
      message: "File lỗi định dạng, đang bỏ qua...",
    },
    {
      label: "Player error: advance_stopped",
      code: "advance_stopped",
      message: "Drive is overloaded or locked — auto-playback paused.",
    },
    {
      label: "Player error: rate_limited",
      code: "rate_limited",
      message: "Request rate limit exceeded — try again later.",
    },
    {
      label: "Player error: access_denied",
      code: "access_denied",
      message: "Access denied — the file may no longer be available.",
    },
  ])(
    "demo $code button dispatches PLAYER_ERROR with the preset message",
    ({ label, code, message }) => {
      render(<DebugPanel />);
      openPanel();
      const spy = vi.spyOn(window, "dispatchEvent");

      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(spy).toHaveBeenCalledTimes(1);
      const event = spy.mock.calls[0]?.[0] as CustomEvent;
      expect(event.type).toBe(DEBUG_EVENTS.PLAYER_ERROR);
      expect(event.detail).toEqual({ code, message });
    },
  );

  it("closes when the X close button is clicked", () => {
    render(<DebugPanel />);
    openPanel();
    expect(screen.getByText("Debug UI")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByText("Debug UI")).toBeNull();
  });

  it("removes the keydown listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<DebugPanel />);

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));

    // A stray shortcut after unmount must be a no-op (no crash, no panel).
    openPanel();
    expect(screen.queryByText("Debug UI")).toBeNull();
  });
});
