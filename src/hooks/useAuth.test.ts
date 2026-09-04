// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAuth } from "./useAuth";
import { invalidateCurrentSession } from "../utils/sessionGuard";
import {
  revokeGoogleToken,
  stopProactiveRefresh,
  scheduleProactiveRefresh,
  writeRefreshToken,
  readRefreshToken,
  deleteRefreshToken,
} from "../utils/apiClient";
import { clearAllMetadataCache } from "../utils/metadata";
import { captureError } from "../utils/errorLog";
import { fetchWithAuth } from "../utils/apiClient";
import {
  startProSyncWorker,
  stopProSyncWorker,
  setTokenRefreshHandler,
  updateWorkerToken,
  triggerProSync,
} from "../utils/proSyncManager";
import { PRO_SYNC_POLL_MS } from "./useProSyncPoller";
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_TIME_KEY,
  USER_EMAIL_KEY,
} from "../utils/storageKeys";

const authState = vi.hoisted(() => ({
  isLoggedIn: false,
  accessToken: null as string | null,
  userProfile: null,
  setIsLoggedIn: vi.fn(),
  setAccessToken: vi.fn(),
  setUserProfile: vi.fn(),
}));

// Logout DB-teardown mocks (hoisted so the vi.mock factories below can close
// over them; direct method references like db.syncState.delete would trip
// @typescript-eslint/unbound-method).
const { mockedSyncStateDelete, mockedWipeFileRowsForUser } = vi.hoisted(() => ({
  mockedSyncStateDelete: vi.fn(() => Promise.resolve()),
  mockedWipeFileRowsForUser: vi.fn<(email: string) => Promise<void>>(() =>
    Promise.resolve(),
  ),
}));

vi.mock("../db/db", () => ({
  db: {
    files: { clear: vi.fn(() => Promise.resolve()) },
    syncState: { delete: mockedSyncStateDelete },
  },
}));

vi.mock("../db/fileRows", () => ({
  wipeFileRowsForUser: mockedWipeFileRowsForUser,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => () => {}),
}));

vi.mock("../store/authStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector(authState),
}));

vi.mock("../utils/proSyncManager", () => ({
  startProSyncWorker: vi.fn(),
  stopProSyncWorker: vi.fn(),
  setTokenRefreshHandler: vi.fn(),
  updateWorkerToken: vi.fn(),
  triggerProSync: vi.fn(),
}));

vi.mock("../utils/sessionGuard", () => ({
  invalidateCurrentSession: vi.fn(),
}));

vi.mock("../utils/apiClient", () => ({
  revokeGoogleToken: vi.fn(),
  stopProactiveRefresh: vi.fn(),
  fetchWithAuth: vi.fn(),
  getValidToken: vi.fn(),
  scheduleProactiveRefresh: vi.fn(),
  writeRefreshToken: vi.fn(),
  readRefreshToken: vi.fn(),
  deleteRefreshToken: vi.fn(),
  TOKEN_EXPIRY_MS: 50 * 60 * 1000,
}));

vi.mock("../utils/cache", () => ({
  CLEAR_LOCAL_CACHE_CMD: "clear_local_cache",
  clearAppCache: vi.fn(),
}));

vi.mock("../utils/metadata", () => ({
  clearAllMetadataCache: vi.fn(),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

vi.mock("./usePlayer", () => ({
  PLAYER_STOP_EVENT: "player-stop",
}));

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);
const mockedInvalidateCurrentSession = vi.mocked(invalidateCurrentSession);
const mockedRevokeGoogleToken = vi.mocked(revokeGoogleToken);
const mockedStopProactiveRefresh = vi.mocked(stopProactiveRefresh);
const mockedClearAllMetadataCache = vi.mocked(clearAllMetadataCache);
const mockedCaptureError = vi.mocked(captureError);
const mockedFetchWithAuth = vi.mocked(fetchWithAuth);
const mockedStartProSyncWorker = vi.mocked(startProSyncWorker);
const mockedStopProSyncWorker = vi.mocked(stopProSyncWorker);
const mockedSetTokenRefreshHandler = vi.mocked(setTokenRefreshHandler);
const mockedScheduleProactiveRefresh = vi.mocked(scheduleProactiveRefresh);
const mockedUpdateWorkerToken = vi.mocked(updateWorkerToken);
const mockedTriggerProSync = vi.mocked(triggerProSync);
const mockedWriteRefreshToken = vi.mocked(writeRefreshToken);
const mockedReadRefreshToken = vi.mocked(readRefreshToken);
const mockedDeleteRefreshToken = vi.mocked(deleteRefreshToken);

const invokedCommands = (): string[] =>
  mockedInvoke.mock.calls.map((call) => call[0]);

// Fake only timers (never setImmediate) so React's scheduler keeps flushing
// on the real event loop while the poll/debounce timers stay controllable.
const FAKE_TIMERS_TOFAKE = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedInvoke.mockImplementation(() => Promise.resolve(undefined));
  mockedListen.mockResolvedValue(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAuth init effect token expiry model (B1)", () => {
  it("schedules the proactive refresh from the stale threshold (TOKEN_EXPIRY_MS), not the 3600s server lifetime", () => {
    // Seed a token issued 48 minutes ago: still "valid" under the 50-min stale
    // threshold (TOKEN_EXPIRY_MS), so getValidToken would NOT refresh on use,
    // and the init effect must schedule a proactive refresh that fires BEFORE
    // the stale threshold. Remaining time until stale = 3000 - 2880 = ~120s.
    // Before the fix the hook used 3600 - 2880 = 720s â€” the timer would have
    // fired AFTER getValidToken already treats the token as stale.
    localStorage.setItem(ACCESS_TOKEN_KEY, "tok-123");
    localStorage.setItem(TOKEN_TIME_KEY, String(Date.now() - 48 * 60 * 1000));

    renderHook(() => useAuth());

    expect(mockedScheduleProactiveRefresh).toHaveBeenCalledTimes(1);
    const firstCall = mockedScheduleProactiveRefresh.mock.calls[0];
    if (firstCall === undefined)
      throw new Error("expected scheduleProactiveRefresh call");
    const remainingSec = firstCall[0];
    expect(remainingSec).toBeGreaterThanOrEqual(110);
    expect(remainingSec).toBeLessThanOrEqual(130);
  });
});

describe("useAuth token-updated listener (B2)", () => {
  it("updates the store and worker even when NOT logged in (regression: refresh fired before gated effect mounted)", () => {
    renderHook(() => useAuth());

    act(() => {
      window.dispatchEvent(
        new CustomEvent("token-updated", { detail: { token: "fresh-token" } }),
      );
    });

    expect(authState.setAccessToken).toHaveBeenCalledWith("fresh-token");
    expect(mockedUpdateWorkerToken).toHaveBeenCalledWith("fresh-token");
  });

  it("ignores token-updated with a non-string token (guard preserved)", () => {
    renderHook(() => useAuth());

    act(() => {
      window.dispatchEvent(
        new CustomEvent("token-updated", { detail: { token: 42 } }),
      );
    });

    expect(authState.setAccessToken).not.toHaveBeenCalled();
    expect(mockedUpdateWorkerToken).not.toHaveBeenCalled();
  });
});

describe("useAuth token-expired listener removed (B5)", () => {
  it("never registers a Tauri listener for token-expired (emitter deleted with the Rust proxy in a134f77)", () => {
    renderHook(() => useAuth());

    expect(mockedListen.mock.calls.map((call) => call[0])).not.toContain(
      "token-expired",
    );
  });
});

describe("useAuth worker lifecycle (B4)", () => {
  afterEach(() => {
    vi.useRealTimers();
    // The hoisted authState mock persists across tests; restore the default
    // logged-out shape so later suites keep their assumed initial state.
    authState.isLoggedIn = false;
    authState.accessToken = null;
  });

  it("starts the worker exactly once at login and does NOT restart it when the token is refreshed", () => {
    // LOGGED IN: store carries the login token; localStorage seeds the init
    // effect so scheduleProactiveRefresh runs like in a real session.
    authState.isLoggedIn = true;
    authState.accessToken = "tok-A";
    localStorage.setItem(ACCESS_TOKEN_KEY, "tok-A");

    const { rerender } = renderHook(() => useAuth());

    // Worker lifecycle is owned by the isLoggedIn-gated effect: exactly one
    // start with the login-time token.
    expect(mockedStartProSyncWorker).toHaveBeenCalledTimes(1);
    expect(mockedStartProSyncWorker).toHaveBeenCalledWith("tok-A");

    // Simulate a successful refresh: the B2 listener propagates the new token
    // to the store (rerender) and to the worker via updateWorkerToken.
    act(() => {
      authState.accessToken = "tok-B";
      window.dispatchEvent(
        new CustomEvent("token-updated", { detail: { token: "tok-B" } }),
      );
      rerender();
    });

    // Regression: pre-fix the accessToken dep re-ran the gated effect, whose
    // cleanup terminated the running worker mid-sync (lost isBusy/retry state).
    expect(mockedStopProSyncWorker).not.toHaveBeenCalled();
    // Worker receives the new token through the in-place update channel (B2).
    expect(mockedUpdateWorkerToken).toHaveBeenCalledWith("tok-B");
    // Still exactly one start, with the login token â€” no stop/start churn.
    expect(mockedStartProSyncWorker).toHaveBeenCalledTimes(1);
    expect(mockedStartProSyncWorker).toHaveBeenCalledWith("tok-A");
    // Refresh handler stays registered for the whole session.
    expect(mockedSetTokenRefreshHandler).toHaveBeenLastCalledWith(
      expect.any(Function),
    );
  });

  it("mounts the poller at login (immediate trigger) and unmounts it at logout", () => {
    try {
      vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
      authState.isLoggedIn = true;
      authState.accessToken = "tok-A";
      localStorage.setItem(ACCESS_TOKEN_KEY, "tok-A");

      const { rerender } = renderHook(() => useAuth());

      // Poller mounted with a valid token: one immediate trigger.
      expect(mockedTriggerProSync).toHaveBeenCalledTimes(1);

      mockedTriggerProSync.mockClear();
      authState.isLoggedIn = false;
      authState.accessToken = null;
      act(() => {
        rerender();
      });

      // Poller unmounted: advancing past the poll interval must not trigger
      // a sync after logout. (Focus-listener removal is covered thoroughly in
      // useProSyncPoller.test.tsx â€” dispatching focus here would also hit the
      // listener of a still-mounted hook from a previous test, since RTL
      // auto-cleanup is disabled in this repo.)
      act(() => {
        vi.advanceTimersByTime(PRO_SYNC_POLL_MS * 3);
      });
      expect(mockedTriggerProSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useAuth handleLogout backend cleanup", () => {
  it("does NOT invoke the removed clear_stream_token command (regression: command deleted in the SW migration)", async () => {
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(invokedCommands()).not.toContain("clear_stream_token");
    expect(invokedCommands()).toContain("clear_local_cache");
    expect(mockedClearAllMetadataCache).toHaveBeenCalled();
    expect(mockedInvalidateCurrentSession).toHaveBeenCalled();
    expect(mockedStopProSyncWorker).toHaveBeenCalled();
    expect(mockedStopProactiveRefresh).toHaveBeenCalled();
    expect(onLogoutExt).toHaveBeenCalled();
    expect(
      mockedCaptureError.mock.calls.some(([c]) =>
        c.message.includes("clear_stream_token"),
      ),
    ).toBe(false);
  });

  it("skips clear_stream_token also when a token is present and revoke runs (variant: token branch)", async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "tok-123");
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(invokedCommands()).not.toContain("clear_stream_token");
    expect(mockedRevokeGoogleToken).toHaveBeenCalledWith("tok-123");
    expect(onLogoutExt).toHaveBeenCalled();
  });

  it("logs a warn and continues logout when clear_local_cache fails (contract preserved)", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "clear_local_cache") {
        return Promise.reject(new Error("backend down"));
      }
      return Promise.resolve(undefined);
    });
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(onLogoutExt).toHaveBeenCalled();
    expect(
      mockedCaptureError.mock.calls.some(([c]) =>
        c.message.includes("Failed to clear backend cache"),
      ),
    ).toBe(true);
  });
});

describe("useAuth keyring-backed login/logout (M1c)", () => {
  it("writes the refresh token to the keyring and never to localStorage on login", () => {
    const { result } = renderHook(() => useAuth());

    act(() => {
      result.current.handleLoginSuccess({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
      });
    });

    expect(mockedWriteRefreshToken).toHaveBeenCalledWith("r");
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    // Access token + token_time still go to localStorage (contract preserved).
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("a");
    expect(localStorage.getItem(TOKEN_TIME_KEY)).not.toBeNull();
  });

  it("skips the keyring write when the login response has no refresh_token", () => {
    const { result } = renderHook(() => useAuth());

    act(() => {
      result.current.handleLoginSuccess({
        access_token: "a",
        expires_in: 3600,
      });
    });

    expect(mockedWriteRefreshToken).not.toHaveBeenCalled();
  });

  it("deletes the refresh token from the keyring on logout (no keyring residue)", async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "tok-123");
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockedDeleteRefreshToken).toHaveBeenCalledTimes(1);
    // Existing revoke behavior preserved.
    expect(mockedRevokeGoogleToken).toHaveBeenCalledWith("tok-123");
    expect(invokedCommands()).toContain("clear_local_cache");
  });
});

describe("useAuth handleLogout revokes the refresh token too (M2)", () => {
  it("revokes the access token THEN the keyring refresh token on logout (order matters)", async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "tok-123");
    mockedReadRefreshToken.mockResolvedValue("rt-1");
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await act(async () => {
      await result.current.handleLogout();
    });

    // The read must happen BEFORE the localStorage clear: readRefreshToken
    // falls back to the legacy LS copy when the keyring read fails.
    expect(mockedReadRefreshToken).toHaveBeenCalledTimes(1);
    // Revoke order: access token first, then the long-lived refresh token.
    expect(mockedRevokeGoogleToken.mock.calls.map((call) => call[0])).toEqual([
      "tok-123",
      "rt-1",
    ]);
    expect(mockedDeleteRefreshToken).toHaveBeenCalledTimes(1);
    expect(onLogoutExt).toHaveBeenCalled();
  });

  it("revokes only the access token when no refresh token is readable (contract preserved)", async () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "tok-123");
    mockedReadRefreshToken.mockResolvedValue(null);
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockedRevokeGoogleToken).toHaveBeenCalledTimes(1);
    expect(mockedRevokeGoogleToken).toHaveBeenCalledWith("tok-123");
    expect(mockedDeleteRefreshToken).toHaveBeenCalledTimes(1);
    expect(onLogoutExt).toHaveBeenCalled();
  });
});

// Logout account-boundary teardown (schema v10): db.files rows are keyed
// [userEmail+id], so logout wipes ONLY the logged-out account's mirror, and
// the Drive changes cursor (db.syncState "startPageToken") must never survive
// a logout — otherwise the NEXT account's first sync delta-applies another
// account's change window onto its own mirror.
describe("useAuth logout DB wipes (per-user files + sync cursor)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(USER_EMAIL_KEY);
  });

  it("wipes the logged-out account's file rows AND deletes the sync cursor on logout", async () => {
    localStorage.setItem(USER_EMAIL_KEY, "out@example.com");
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockedWipeFileRowsForUser).toHaveBeenCalledWith("out@example.com");
    expect(mockedSyncStateDelete).toHaveBeenCalledWith("startPageToken");
  });

  it("deletes the sync cursor EVEN WHEN the files wipe fails (independence) and logout still resolves", async () => {
    localStorage.setItem(USER_EMAIL_KEY, "out@example.com");
    mockedWipeFileRowsForUser.mockRejectedValueOnce(new Error("idb down"));
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await expect(
      act(async () => {
        await result.current.handleLogout();
      }),
    ).resolves.toBeUndefined();

    // The two teardowns are independent: a failed file wipe must not skip
    // the cursor delete nor abort the rest of logout.
    expect(mockedSyncStateDelete).toHaveBeenCalledWith("startPageToken");
    expect(onLogoutExt).toHaveBeenCalled();
    expect(
      mockedCaptureError.mock.calls.some(([c]) =>
        c.message.includes("Files persisted-wipe failed"),
      ),
    ).toBe(true);
  });

  it("skips the file-row wipe when no real account email was ever known, but STILL deletes the cursor", async () => {
    // beforeEach cleared localStorage — no USER_EMAIL_KEY, so no account is
    // reliably identified and there is nothing owned to wipe.
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockedWipeFileRowsForUser).not.toHaveBeenCalled();
    expect(mockedSyncStateDelete).toHaveBeenCalledWith("startPageToken");
  });
});

describe("useAuth profile fetch abort handling (isAbortError unified)", () => {
  const renderLoggedIn = () => {
    authState.isLoggedIn = true;
    authState.accessToken = "tok-123";
    localStorage.setItem(ACCESS_TOKEN_KEY, "tok-123");
    renderHook(() => useAuth());
  };

  afterEach(() => {
    authState.isLoggedIn = false;
    authState.accessToken = null;
  });

  it("does not log when the profile fetch is aborted (DOMException AbortError, jsdom shape not instanceof Error)", async () => {
    mockedFetchWithAuth.mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    renderLoggedIn();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("does not log a duck-typed AbortError reject (name field only, no Error/DOMException identity)", async () => {
    mockedFetchWithAuth.mockRejectedValue({ name: "AbortError" });

    renderLoggedIn();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("logs the profile fetch failure for a non-AbortError reject that is not an Error instance (was silently swallowed)", async () => {
    mockedFetchWithAuth.mockRejectedValue({
      name: "SomeError",
      message: "boom",
    });

    renderLoggedIn();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      mockedCaptureError.mock.calls.some(([c]) =>
        c.message.includes("Failed to fetch user profile (best-effort)"),
      ),
    ).toBe(true);
  });

  it("still logs a plain Error reject (network failure path preserved)", async () => {
    mockedFetchWithAuth.mockRejectedValue(new Error("network down"));

    renderLoggedIn();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      mockedCaptureError.mock.calls.some(([c]) =>
        c.message.includes("Failed to fetch user profile (best-effort)"),
      ),
    ).toBe(true);
  });
});
