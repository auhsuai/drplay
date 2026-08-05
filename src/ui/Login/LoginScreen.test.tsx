// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { captureError } from "../../utils/errorLog";
import { LoginScreen } from "./LoginScreen";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("../../utils/errorLog", () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

const invokeMock = vi.mocked(invoke);
const captureErrorMock = vi.mocked(captureError);

function renderLogin() {
  const onLogin = vi.fn();
  render(<LoginScreen onLogin={onLogin} />);
  return { onLogin };
}

function toastRootText(): string {
  return document.getElementById("toast-root")?.textContent ?? "";
}

describe("LoginScreen invoke login error handling", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast-root"></div>';
    invokeMock.mockReset();
    captureErrorMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows cancel toast and logs login-cancelled when user cancels authorization", async () => {
    invokeMock.mockRejectedValueOnce("User cancelled authorization");
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(toastRootText()).toContain("Đăng nhập đã bị hủy");
    });
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "LoginScreen",
        kind: "login-cancelled",
      }),
    );
  });

  it("shows timeout toast on authorization timeout", async () => {
    invokeMock.mockRejectedValueOnce(
      "Authorization timeout: user did not complete login within 5 minutes.",
    );
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(toastRootText()).toContain(
        "Đăng nhập quá thời gian chờ, vui lòng thử lại.",
      );
    });
  });

  it("shows failed toast and logs login-failed on unexpected error", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(toastRootText()).toContain(
        "Đăng nhập thất bại, vui lòng thử lại.",
      );
    });
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "LoginScreen",
        kind: "login-failed",
      }),
    );
  });

  it("forwards both access_token and refresh_token to onLogin on successful invoke", async () => {
    invokeMock.mockResolvedValueOnce({
      access_token: "token-123",
      refresh_token: "refresh-456",
    });
    const { onLogin } = renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith({
        access_token: "token-123",
        refresh_token: "refresh-456",
      });
    });
    expect(toastRootText()).toBe("");
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("forwards access_token to onLogin when refresh_token is absent", async () => {
    invokeMock.mockResolvedValueOnce({ access_token: "token-123" });
    const { onLogin } = renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith({ access_token: "token-123" });
    });
    expect(toastRootText()).toBe("");
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("forwards expires_in from the Rust login payload to onLogin (type contract for B1)", async () => {
    invokeMock.mockResolvedValueOnce({
      access_token: "token-123",
      refresh_token: "refresh-456",
      expires_in: 3599,
    });
    const { onLogin } = renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith({
        access_token: "token-123",
        refresh_token: "refresh-456",
        expires_in: 3599,
      });
    });
    expect(toastRootText()).toBe("");
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("renders the cancel action as a real <button> (keyboard accessible)", () => {
    const CANCEL_DELAY_MS = 5000;
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementation(() => new Promise(() => {}));
      renderLogin();
      fireEvent.click(screen.getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(CANCEL_DELAY_MS);
      });
      const cancelAction = screen.getByRole("button", { name: "Hủy" });
      expect(cancelAction.tagName).toBe("BUTTON");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel button still triggers the cancel flow (toast shown)", () => {
    const CANCEL_DELAY_MS = 5000;
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementation(() => new Promise(() => {}));
      renderLogin();
      fireEvent.click(screen.getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(CANCEL_DELAY_MS);
      });
      fireEvent.click(screen.getByRole("button", { name: "Hủy" }));
      expect(toastRootText()).toContain("Đã hủy thao tác kết nối.");
    } finally {
      vi.useRealTimers();
    }
  });
});
