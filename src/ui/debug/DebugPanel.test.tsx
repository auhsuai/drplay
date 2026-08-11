// @vitest-environment jsdom
import { Component } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DebugPanel } from "./DebugPanel";
import { DEBUG_EVENTS } from "./debugEvents";

// DebugPanel now consumes react-i18next (login toast keys). No initialized
// i18n instance exists in the jsdom test env — stub t() to return the key so
// assertions pin the exact translation key (the shipped strings are verified
// by LoginScreen.test against the real locale resources).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const debugMocks = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: debugMocks.showErrorToast,
  showSuccessToast: debugMocks.showSuccessToast,
}));
vi.mock("../../utils/errorLog", () => ({
  captureError: debugMocks.captureError,
}));

const GB = 1024 * 1024 * 1024;

const openPanel = () => {
  fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });
};

// Test-local ErrorBoundary: the crash button makes DebugPanel throw inside its
// render, exactly like the app-level ErrorBoundary (main.tsx) catches it in
// production. Without a boundary the throw would escape the test renderer.
class TestErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div role="alert" data-testid="test-boundary-fallback">
          Boundary fallback
        </div>
      );
    }
    return this.props.children;
  }
}

describe("DebugPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
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

  it.each([
    {
      label: "Quota: under 80% (blue)",
      usageInDrive: 40 * GB,
      limit: 100 * GB,
    },
    { label: "Quota: over 80% (red)", usageInDrive: 95 * GB, limit: 100 * GB },
    { label: "Quota: unlimited", usageInDrive: 50 * GB, limit: null },
  ])(
    "demo $label button dispatches QUOTA with the preset detail",
    ({ label, usageInDrive, limit }) => {
      render(<DebugPanel />);
      openPanel();
      const spy = vi.spyOn(window, "dispatchEvent");

      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(spy).toHaveBeenCalledTimes(1);
      const event = spy.mock.calls[0]?.[0] as CustomEvent;
      expect(event.type).toBe(DEBUG_EVENTS.QUOTA);
      expect(event.detail).toEqual({ usageInDrive, limit });
    },
  );

  it.each([
    { label: "Empty: Playlist", event: DEBUG_EVENTS.PLAYLIST_EMPTY },
    { label: "Empty: Liked Songs", event: DEBUG_EVENTS.LIKED_EMPTY },
    { label: "Empty: Trash", event: DEBUG_EVENTS.TRASH_EMPTY },
    { label: "Empty: Folder selection", event: DEBUG_EVENTS.FOLDERS_EMPTY },
  ])(
    "$label button dispatches $event with undefined detail",
    ({ label, event }) => {
      render(<DebugPanel />);
      openPanel();
      const spy = vi.spyOn(window, "dispatchEvent");

      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(spy).toHaveBeenCalledTimes(1);
      const dispatched = spy.mock.calls[0]?.[0] as CustomEvent;
      expect(dispatched.type).toBe(event);
      // jsdom normalizes the app's `{ detail: undefined }` init to null.
      expect(dispatched.detail).toBeNull();
    },
  );

  it("crash button throws during render and the surrounding ErrorBoundary shows its fallback", () => {
    render(
      <TestErrorBoundary>
        <DebugPanel />
      </TestErrorBoundary>,
    );
    openPanel();
    expect(screen.getByText("Debug UI")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /crash ui/i }));

    expect(screen.getByTestId("test-boundary-fallback")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("Error toast button calls showErrorToast with the debug message", () => {
    render(<DebugPanel />);
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Error toast" }));

    expect(debugMocks.showErrorToast).toHaveBeenCalledWith("Debug error toast");
  });

  it("Success toast button calls showSuccessToast with the debug message", () => {
    render(<DebugPanel />);
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Success toast" }));

    expect(debugMocks.showSuccessToast).toHaveBeenCalledWith(
      "Debug success toast",
    );
  });

  it.each([
    { label: "Login: cancelled", key: "login.cancelled" },
    { label: "Login: timeout", key: "login.timeout_error" },
    { label: "Login: failed", key: "login.failed" },
  ])(
    "$label shows an error toast with the translated key $key",
    ({ label, key }) => {
      render(<DebugPanel />);
      openPanel();

      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(debugMocks.showErrorToast).toHaveBeenCalledWith(key);
    },
  );

  it("Seed error log entry button captures a log entry sourced from DebugPanel", () => {
    render(<DebugPanel />);
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: /seed error log/i }));

    expect(debugMocks.captureError).toHaveBeenCalledWith({
      level: "error",
      source: "DebugPanel",
      message: "Debug seed error log entry",
    });
  });
});
