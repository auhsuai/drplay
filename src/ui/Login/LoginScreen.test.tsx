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
      t: (key: string, fallback?: string | { defaultValue?: string }) =>
        resolveKey(key) ??
        (typeof fallback === "string" ? fallback : fallback?.defaultValue) ??
        key,
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
  return Array.from(document.querySelectorAll<HTMLElement>(".app-toast"))
    .map((el) => el.textContent ?? "")
    .join("\n");
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

  it("shows setup hint toast and logs login-not-configured when mobile OAuth client is not configured", async () => {
    platformMock.IS_MOBILE = true;
    invokeMock.mockRejectedValueOnce(
      "login_google_mobile: ANDROID_CLIENT_ID is not configured — follow the GCP setup documented in src-tauri/src/auth_android.rs",
    );
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(toastRootText()).toContain(
        "Google login is not configured on this device — an Android OAuth client is required in Google Console.",
      );
    });
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "LoginScreen",
        kind: "login-not-configured",
      }),
    );
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
        screen.getByText("Opened the browser — waiting for sign-in..."),
      ).toBeTruthy();
    });
  });

  it("does not show the browser-opened hint on desktop", () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    renderLogin();

    fireEvent.click(screen.getByRole("button"));

    expect(
      screen.queryByText("Opened the browser — waiting for sign-in..."),
    ).toBeNull();
  });

  interface DeferredToken {
    access_token: string;
  }

  function deferToken(): {
    promise: Promise<DeferredToken>;
    resolve: (value: DeferredToken) => void;
    reject: (error: unknown) => void;
  } {
    let resolve!: (value: DeferredToken) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<DeferredToken>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("supersedes a cancelled attempt: its late success never reaches onLogin", async () => {
    const CANCEL_DELAY_MS = 5000;
    const first = deferToken();
    const second = deferToken();
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementationOnce(() => first.promise);
      invokeMock.mockImplementationOnce(() => second.promise);
      const { onLogin } = renderLogin();

      // Attempt A starts and stays pending while the user cancels it.
      fireEvent.click(screen.getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(CANCEL_DELAY_MS);
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(toastRootText()).toContain("Connection cancelled.");

      // Attempt B starts while A's invoke promise is still unresolved.
      fireEvent.click(screen.getByRole("button"));

      // Late success of superseded attempt A must be dropped silently.
      await act(async () => {
        first.resolve({ access_token: "token-A" });
        await Promise.resolve();
      });
      expect(onLogin).not.toHaveBeenCalled();
      expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);

      // Attempt B completes normally.
      await act(async () => {
        second.resolve({ access_token: "token-B" });
        await Promise.resolve();
      });
      expect(onLogin).toHaveBeenCalledTimes(1);
      expect(onLogin).toHaveBeenCalledWith({ access_token: "token-B" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late successful resolution after the user cancels", async () => {
    const CANCEL_DELAY_MS = 5000;
    const deferred = deferToken();
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementationOnce(() => deferred.promise);
      const { onLogin } = renderLogin();

      fireEvent.click(screen.getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(CANCEL_DELAY_MS);
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const toastAfterCancel = toastRootText();
      expect(toastAfterCancel).toContain("Connection cancelled.");

      await act(async () => {
        deferred.resolve({ access_token: "late-token" });
        await Promise.resolve();
      });
      expect(onLogin).not.toHaveBeenCalled();
      expect(toastRootText()).toBe(toastAfterCancel);
      expect(captureErrorMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late error rejection after the user cancels", async () => {
    const CANCEL_DELAY_MS = 5000;
    const deferred = deferToken();
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementationOnce(() => deferred.promise);
      const { onLogin } = renderLogin();

      fireEvent.click(screen.getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(CANCEL_DELAY_MS);
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const toastAfterCancel = toastRootText();
      expect(toastAfterCancel).toContain("Connection cancelled.");

      await act(async () => {
        deferred.reject(new Error("User cancelled authorization"));
        await Promise.resolve();
      });
      expect(onLogin).not.toHaveBeenCalled();
      expect(toastRootText()).toBe(toastAfterCancel);
      expect(captureErrorMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending attempt resolution that arrives after unmount", async () => {
    const deferred = deferToken();
    invokeMock.mockImplementationOnce(() => deferred.promise);
    const { onLogin } = renderLogin();

    fireEvent.click(screen.getByRole("button"));
    cleanup();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        deferred.resolve({ access_token: "late-token" });
        await Promise.resolve();
      });
      expect(onLogin).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("LoginScreen google-login cancel command wiring", () => {
  const CANCEL_DELAY_MS = 5000;
  const CANCEL_COMMAND = "cancel_google_login";

  interface PendingToken {
    access_token: string;
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="content-area"></div>';
    invokeMock.mockReset();
    captureErrorMock.mockClear();
    platformMock.IS_MOBILE = false;
  });

  afterEach(() => {
    cleanup();
  });

  function countCancelCalls(): number {
    return invokeMock.mock.calls.filter(
      ([command]) => command === CANCEL_COMMAND,
    ).length;
  }

  // The login invoke must stay pending (like the real Rust waiter), so the
  // stub discriminates by command name — only the cancel command is scripted.
  function stubInvokePendingLogin(cancelOutcome: () => Promise<unknown>): void {
    invokeMock.mockImplementation((command: string) =>
      command === CANCEL_COMMAND
        ? cancelOutcome()
        : new Promise<PendingToken>(() => {}),
    );
  }

  it("cancel click on mobile invokes cancel_google_login exactly once and keeps the cancelled toast", () => {
    platformMock.IS_MOBILE = true;
    stubInvokePendingLogin(() => Promise.resolve(null));
    vi.useFakeTimers();
    try {
      renderLogin();
      fireEvent.click(screen.getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(CANCEL_DELAY_MS);
      });
      expect(countCancelCalls()).toBe(0);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(countCancelCalls()).toBe(1);
      expect(toastRootText()).toContain("Connection cancelled.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmount while a login is pending on mobile invokes cancel_google_login exactly once", () => {
    platformMock.IS_MOBILE = true;
    stubInvokePendingLogin(() => Promise.resolve(null));
    renderLogin();

    fireEvent.click(screen.getByRole("button"));
    expect(countCancelCalls()).toBe(0);

    cleanup();

    expect(countCancelCalls()).toBe(1);
  });

  it("cancel click on desktop never invokes cancel_google_login", () => {
    // platformMock.IS_MOBILE stays false — desktop flow.
    stubInvokePendingLogin(() => Promise.resolve(null));
    vi.useFakeTimers();
    try {
      renderLogin();
      fireEvent.click(screen.getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(CANCEL_DELAY_MS);
      });

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(toastRootText()).toContain("Connection cancelled.");
      expect(countCancelCalls()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejected cancel invoke stays silent: no new toast, no state flip", async () => {
    platformMock.IS_MOBILE = true;
    stubInvokePendingLogin(() =>
      Promise.reject(new Error("cancel_google_login unavailable")),
    );
    vi.useFakeTimers();
    try {
      const { onLogin } = renderLogin();
      fireEvent.click(screen.getByRole("button"));
      act(() => {
        vi.advanceTimersByTime(CANCEL_DELAY_MS);
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const toastAfterCancel = toastRootText();
      expect(toastAfterCancel).toContain("Connection cancelled.");

      // Flush the rejected cancel promise through its handler.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(countCancelCalls()).toBe(1);
      expect(toastRootText()).toBe(toastAfterCancel);
      expect(captureErrorMock).not.toHaveBeenCalled();
      expect(onLogin).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
