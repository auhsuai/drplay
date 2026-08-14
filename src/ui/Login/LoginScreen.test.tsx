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
import en from "../../locales/en/translation.json";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// IS_MOBILE is read inside handleLoginClick (call time), so a getter-backed
// mock lets individual tests toggle the platform — same pattern as
// driveFiles.recentlyAdded.test.ts.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

vi.mock("react-i18next", () => {
  // Resolve keys against the real en resources so assertions read the
  // shipped copy instead of hard-coded fallbacks.
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string) => resolveKey(key) ?? fallback ?? key,
    }),
  };
});

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
  return document.getElementById("content-area")?.textContent ?? "";
}

describe("LoginScreen invoke login error handling", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="content-area"></div>';
    invokeMock.mockReset();
    captureErrorMock.mockClear();
    platformMock.IS_MOBILE = false;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows cancel toast and logs login-cancelled when user cancels authorization", async () => {
    invokeMock.mockRejectedValueOnce("User cancelled authorization");
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(toastRootText()).toContain("Login cancelled");
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
      expect(toastRootText()).toContain("Login timed out. Try again.");
    });
  });

  it("shows failed toast and logs login-failed on unexpected error", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(toastRootText()).toContain("Login failed. Try again.");
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
      const cancelAction = screen.getByRole("button", { name: "Cancel" });
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
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(toastRootText()).toContain("Connection cancelled.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invokes login_google_mobile on mobile", async () => {
    platformMock.IS_MOBILE = true;
    invokeMock.mockResolvedValueOnce({ access_token: "token-123" });
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("login_google_mobile");
    });
  });

  it("invokes login_google_native on desktop", async () => {
    invokeMock.mockResolvedValueOnce({ access_token: "token-123" });
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("login_google_native");
    });
  });

  it("shows the browser-opened hint while waiting on mobile", async () => {
    platformMock.IS_MOBILE = true;
    invokeMock.mockImplementation(() => new Promise(() => {}));
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(
        screen.getByText("Đã mở trình duyệt — chờ đăng nhập..."),
      ).toBeTruthy();
    });
  });

  it("does not show the browser-opened hint on desktop", () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    expect(
      screen.queryByText("Đã mở trình duyệt — chờ đăng nhập..."),
    ).toBeNull();
  });
});
