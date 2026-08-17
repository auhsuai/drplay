import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  fetchWithAuth,
  getValidToken,
  readRefreshToken,
  writeRefreshToken,
  deleteRefreshToken,
  TokenRefreshError,
  scheduleProactiveRefresh,
} from "./apiClient";
import { stopProactiveRefresh } from "./apiClient";
import { captureError } from "./errorLog";
import { getCurrentSessionId } from "./sessionGuard";
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_TIME_KEY,
} from "./storageKeys";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./sessionGuard", () => ({
  getCurrentSessionId: vi.fn(),
  invalidateCurrentSession: vi.fn(),
}));

// captureError is made a no-op mock so keyring-failure paths are assertable
// without depending on the dexie/IndexedDB layer (node test environment).
vi.mock("./errorLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./errorLog")>();
  return {
    ...actual,
    captureError: vi.fn().mockResolvedValue(undefined),
  };
});

const invokeMock = vi.mocked(invoke);
const getCurrentSessionIdMock = vi.mocked(getCurrentSessionId);
const captureErrorMock = vi.mocked(captureError);

// Command-aware invoke mock: maps each Tauri command name to a value or
// handler. Always returns a promise (like the real invoke) so withTimeout
// receives a thenable; unknown commands reject loudly to surface typos.
type InvokeHandler = (args?: Record<string, unknown>) => unknown;
type CommandHandlers = Record<string, unknown>;

function mockInvoke(handlers: CommandHandlers): void {
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    if (!(cmd in handlers)) {
      return Promise.reject(new Error(`unexpected invoke command: ${cmd}`));
    }
    const handler = handlers[cmd];
    return typeof handler === "function"
      ? Promise.resolve(
          (handler as InvokeHandler)(
            args as Record<string, unknown> | undefined,
          ),
        )
      : Promise.resolve(handler);
  });
}

function makeStorage(): Storage {
  let s: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in s ? (s[k] ?? null) : null),
    setItem: (k: string, v: string) => {
      s[k] = v;
    },
    removeItem: (k: string) => {
      s = Object.fromEntries(Object.entries(s).filter(([key]) => key !== k));
    },
    clear: () => {
      s = {};
    },
    key: () => null,
    get length() {
      return Object.keys(s).length;
    },
  };
}

let storage: Storage;

beforeEach(async () => {
  storage = makeStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  (
    globalThis as unknown as { window: { dispatchEvent: (e: Event) => void } }
  ).window = {
    dispatchEvent: vi.fn(),
  };
  getCurrentSessionIdMock.mockReset();
  getCurrentSessionIdMock.mockReturnValue(0);
  captureErrorMock.mockClear();
  // Reset the module-level in-memory refresh-token fallback between tests so a
  // failed-keyring write in one test cannot leak into the next. deleteRefreshToken
  // clears the in-memory variable (plus keyring + localStorage); the default
  // invoke mock makes the keyring delete a no-op success.
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  await deleteRefreshToken();
});

afterEach(() => {
  stopProactiveRefresh();
  invokeMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchWithAuth", () => {
  it("attaches the Bearer token to the outgoing request", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "tok-123");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchWithAuth("/api/songs");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected fetch call");
    const opts = firstCall[1] as RequestInit;
    const h = new Headers(opts.headers);
    expect(h.get("Authorization")).toBe("Bearer tok-123");
  });

  it("refreshes the token and retries once on 401", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "old");
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    invokeMock.mockResolvedValue({ access_token: "new", expires_in: 3600 });

    const queue = [
      new Response("", { status: 401 }),
      new Response("data", { status: 200 }),
    ];
    let shiftIndex = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      const response = queue[shiftIndex];
      shiftIndex += 1;
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const res = await fetchWithAuth("/api/songs");

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalled(); // timeout applied on main + reused on retry
    const retryCall = fetchSpy.mock.calls[1];
    if (retryCall === undefined) throw new Error("expected fetch retry call");
    const retryOpts = retryCall[1] as RequestInit;
    const retryHeaders = new Headers(retryOpts.headers);
    expect(retryHeaders.get("Authorization")).toBe("Bearer new");
    expect(storage.getItem(ACCESS_TOKEN_KEY)).toBe("new");
  });

  it("returns the 401 response (no hang) when refresh fails", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "old");
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    invokeMock.mockRejectedValue(new Error("invalid_grant: revoked"));

    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await fetchWithAuth("/api/songs");

    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry attempted
  });

  it("applies AbortSignal.timeout to the request", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "tok");
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchWithAuth("/api/songs");

    expect(timeoutSpy).toHaveBeenCalled();
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    const firstCall = fetchSpy.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected fetch call");
    const opts = firstCall[1] as RequestInit;
    expect(opts.signal).toBeDefined();
  });

  it("uses the caller-supplied timeoutMs override for AbortSignal.timeout", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "tok");
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchWithAuth("/api/songs", { timeoutMs: 30_000 });

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it.each([
    ["0", 0],
    ["negative", -5],
    ["NaN", NaN],
  ])(
    "falls back to the default 15s timeout when timeoutMs is %s",
    async (_label: string, bad: number) => {
      storage.setItem(ACCESS_TOKEN_KEY, "tok");
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);

      await fetchWithAuth("/api/songs", { timeoutMs: bad });

      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    },
  );

  it("keeps the timeout override on the 401 retry (same merged signal)", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "old");
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    invokeMock.mockResolvedValue({ access_token: "new", expires_in: 3600 });

    const queue = [
      new Response("", { status: 401 }),
      new Response("data", { status: 200 }),
    ];
    let shiftIndex = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      const response = queue[shiftIndex];
      shiftIndex += 1;
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const res = await fetchWithAuth("/api/songs", { timeoutMs: 60_000 });

    expect(res.status).toBe(200);
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstCall = fetchSpy.mock.calls[0];
    const secondCall = fetchSpy.mock.calls[1];
    if (firstCall === undefined || secondCall === undefined)
      throw new Error("expected fetch calls");
    const firstSignal = (firstCall[1] as RequestInit).signal;
    const retrySignal = (secondCall[1] as RequestInit).signal;
    expect(retrySignal).toBe(firstSignal);
  });

  it("merges the caller signal with the timeout override via AbortSignal.any", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "tok");
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const anySpy = vi.spyOn(AbortSignal, "any");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchWithAuth("/api/songs", {
      timeoutMs: 45_000,
      signal: controller.signal,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(45_000);
    const timeoutResult = timeoutSpy.mock.results[0];
    if (timeoutResult === undefined) throw new Error("expected timeout result");
    expect(anySpy).toHaveBeenCalledWith([
      controller.signal,
      timeoutResult.value,
    ]);
    const anyResult = anySpy.mock.results[0];
    if (anyResult === undefined) throw new Error("expected any result");
    const firstCall = fetchSpy.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected fetch call");
    const opts = firstCall[1] as RequestInit;
    expect(opts.signal).toBe(anyResult.value);
  });

  it("throws a typed TokenRefreshError (not a raw error) when the 401 retry fails", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "old");
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    invokeMock.mockResolvedValue({ access_token: "new", expires_in: 3600 });

    const queue = [new Response("", { status: 401 }), null];
    const fetchSpy = vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (next === null) throw new Error("network down");
      return next;
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchWithAuth("/api/songs")).rejects.toBeInstanceOf(
      TokenRefreshError,
    );
  });

  it("getValidToken stays falsy-safe (returns string on success, null on failure)", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    invokeMock.mockResolvedValue({ access_token: "abc", expires_in: 3600 });
    const ok = await getValidToken(true);
    expect(typeof ok).toBe("string");
    expect(await getValidToken()).toBe("abc");

    invokeMock.mockRejectedValue(new Error("invalid_grant"));
    const fail = await getValidToken(true);
    expect(fail).toBeNull();
  });
});

describe("getValidToken invoke timeout", () => {
  it("does not hang forever when refresh_google_token never settles (bounded by REFRESH_TIMEOUT_MS)", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    vi.useFakeTimers();
    try {
      // Only the refresh call hangs; the keyring read resolves so the test
      // exercises the REFRESH_TIMEOUT_MS bound (not the keyring timeout).
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "get_refresh_token") return Promise.resolve("rt");
        return new Promise(() => {});
      });
      const resultPromise = getValidToken(true);
      await vi.advanceTimersByTimeAsync(16_000);
      const result = await resultPromise;
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduleProactiveRefresh expiry model (B1)", () => {
  it("schedules the timer at/before the stale threshold minus the refresh margin (never after it)", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      scheduleProactiveRefresh(3600);
      const calls = setTimeoutSpy.mock.calls;
      const lastCall = calls[calls.length - 1];
      if (lastCall === undefined) throw new Error("expected setTimeout call");
      const delayMs = lastCall[1] as number;
      // TOKEN_EXPIRY_MS = 50 * 60 * 1000 (3000s); PROACTIVE_REFRESH_MARGIN_SEC = 300.
      // 3600s server expires_in must be clamped down to the 3000s stale threshold
      // minus the 300s margin => 2_700_000ms. Before the fix the timer fired at
      // 3_300_000ms, i.e. AFTER getValidToken already treats the token as stale.
      expect(delayMs).toBeLessThanOrEqual(50 * 60 * 1000 - 300 * 1000);
      expect(delayMs).toBeGreaterThan(0);
    } finally {
      stopProactiveRefresh();
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("getValidToken session race guard", () => {
  it("does not persist the refreshed token when the session was invalidated mid-refresh", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    invokeMock.mockResolvedValue({ access_token: "new", expires_in: 3600 });
    getCurrentSessionIdMock.mockReturnValueOnce(0).mockReturnValueOnce(1);

    const result = await getValidToken(true);

    expect(getCurrentSessionIdMock).toHaveBeenCalledTimes(2);
    expect(result).toBe("");
    expect(storage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(storage.getItem(TOKEN_TIME_KEY)).toBeNull();
  });
});

describe("M1b keyring-backed refresh token storage", () => {
  it("(a) reads the refresh token from the keyring (not localStorage) when refreshing", async () => {
    storage.setItem(ACCESS_TOKEN_KEY, "old");
    mockInvoke({
      get_refresh_token: "rt-keyring",
      refresh_google_token: { access_token: "new", expires_in: 3600 },
    });

    const result = await getValidToken(true);

    expect(result).toBe("new");
    expect(invokeMock).toHaveBeenCalledWith("refresh_google_token", {
      refreshToken: "rt-keyring",
    });
    expect(storage.getItem(ACCESS_TOKEN_KEY)).toBe("new");
  });

  it("(b) falls back to the legacy localStorage token when the keyring is empty", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt-legacy");
    mockInvoke({
      get_refresh_token: null,
      refresh_google_token: { access_token: "new", expires_in: 3600 },
    });

    const result = await getValidToken(true);

    expect(result).toBe("new");
    expect(invokeMock).toHaveBeenCalledWith("refresh_google_token", {
      refreshToken: "rt-legacy",
    });
  });

  it("(c) falls back to localStorage and logs when the keyring read rejects", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt-legacy");
    mockInvoke({
      get_refresh_token: () =>
        Promise.reject(new Error("credential vault unavailable")),
      refresh_google_token: { access_token: "new", expires_in: 3600 },
    });

    const result = await getValidToken(true);

    expect(result).toBe("new");
    expect(invokeMock).toHaveBeenCalledWith("refresh_google_token", {
      refreshToken: "rt-legacy",
    });
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "apiClient",
        message: expect.stringContaining("keyring") as unknown as string,
      }),
    );
  });

  it("(d) writes the rotated refresh token to the keyring and removes the legacy localStorage copy", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt-legacy");
    mockInvoke({
      get_refresh_token: "rt-keyring",
      refresh_google_token: {
        access_token: "new",
        refresh_token: "rt-new",
        expires_in: 3600,
      },
      set_refresh_token: undefined,
    });

    const result = await getValidToken(true);

    expect(result).toBe("new");
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_refresh_token", {
        token: "rt-new",
      });
    });
    await vi.waitFor(() => {
      expect(storage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    });
  });

  it("(e) keeps the refresh token in memory (never localStorage) when the keyring write fails", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt-legacy");
    mockInvoke({
      get_refresh_token: null,
      refresh_google_token: {
        access_token: "new",
        refresh_token: "rt-new",
        expires_in: 3600,
      },
      set_refresh_token: () =>
        Promise.reject(new Error("credential vault write denied")),
    });

    const result = await getValidToken(true);

    expect(result).toBe("new");
    await vi.waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("keyring") as unknown as string,
        }),
      );
    });
    // Google OAuth best-practice: a refresh token must never live in
    // localStorage, even when the keyring write fails.
    expect(storage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    // The rotated token survives in memory for the current session only.
    mockInvoke({ get_refresh_token: null });
    await expect(readRefreshToken()).resolves.toBe("rt-new");
  });

  it("(f) times out a hanging keyring read and falls back to localStorage", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt-legacy");
    vi.useFakeTimers();
    try {
      mockInvoke({
        // KEYRING_TIMEOUT_MS is 5000 in apiClient.ts; advance past it.
        get_refresh_token: () => new Promise(() => {}),
        refresh_google_token: { access_token: "new", expires_in: 3600 },
      });

      const resultPromise = getValidToken(true);
      await vi.advanceTimersByTimeAsync(5_100);
      const result = await resultPromise;

      expect(result).toBe("new");
      expect(invokeMock).toHaveBeenCalledWith("refresh_google_token", {
        refreshToken: "rt-legacy",
      });
      expect(captureErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("keyring") as unknown as string,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// Secure-storage upgrade (Google OAuth best-practice 2026-05-20: user tokens,
// including refresh tokens, must be stored securely — never localStorage). The
// keyring remains the source of truth; on keyring write failure the token is
// kept in a module-level in-memory variable for the current session only, and
// localStorage is only ever read ONCE as a migration path for pre-keyring
// users (read → write keyring → clear immediately).
describe("refresh token secure storage (no localStorage fallback)", () => {
  it("writeRefreshToken never writes to localStorage when the keyring write fails", async () => {
    mockInvoke({
      set_refresh_token: () => Promise.reject(new Error("vault denied")),
    });

    await writeRefreshToken("secret");

    expect(storage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    // The token survives in memory for the current session.
    mockInvoke({ get_refresh_token: null });
    await expect(readRefreshToken()).resolves.toBe("secret");
  });

  it("readRefreshToken returns null when keyring and in-memory are both empty (no localStorage read)", async () => {
    mockInvoke({ get_refresh_token: null });

    await expect(readRefreshToken()).resolves.toBeNull();
  });

  it("migrates a legacy localStorage token once: reads it, writes the keyring, clears localStorage", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt-legacy");
    mockInvoke({
      get_refresh_token: null,
      set_refresh_token: undefined,
    });

    await expect(readRefreshToken()).resolves.toBe("rt-legacy");

    expect(invokeMock).toHaveBeenCalledWith("set_refresh_token", {
      token: "rt-legacy",
    });
    expect(storage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    // Keyring now holds it: a second read comes from the keyring.
    mockInvoke({
      get_refresh_token: "rt-legacy",
      set_refresh_token: undefined,
    });
    await expect(readRefreshToken()).resolves.toBe("rt-legacy");
  });

  it("deleteRefreshToken clears the in-memory fallback in addition to keyring and localStorage", async () => {
    mockInvoke({
      set_refresh_token: () => Promise.reject(new Error("vault denied")),
    });
    await writeRefreshToken("secret");
    expect(storage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    // Sanity: the same-session read still recovers it from memory.
    mockInvoke({ get_refresh_token: null });
    await expect(readRefreshToken()).resolves.toBe("secret");

    mockInvoke({ delete_refresh_token: undefined });
    await deleteRefreshToken();

    // Keyring empty + localStorage empty → the in-memory copy is gone too.
    mockInvoke({ get_refresh_token: null });
    await expect(readRefreshToken()).resolves.toBeNull();
  });
});

// Spec-guards for the single-flight refresh upgrade: every one of these
// asserts the CURRENT (pre-upgrade) behavior, so they must pass on both the
// subscriber-array implementation and the shared-promise implementation.
describe("getValidToken single-flight refresh", () => {
  const dispatchEventMock = () =>
    (
      globalThis as unknown as {
        window: { dispatchEvent: ReturnType<typeof vi.fn> };
      }
    ).window.dispatchEvent;

  const refreshCallCount = () =>
    invokeMock.mock.calls.filter((call) => call[0] === "refresh_google_token")
      .length;

  it("second concurrent caller shares the same in-flight refresh (single-flight)", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    let releaseRefresh!: (value: unknown) => void;
    mockInvoke({
      get_refresh_token: "rt",
      refresh_google_token: () =>
        new Promise((resolve) => {
          releaseRefresh = resolve;
        }),
    });

    const lead = getValidToken(true);
    const follower = getValidToken(true);

    await vi.waitFor(() => {
      expect(refreshCallCount()).toBe(1);
    });

    releaseRefresh({ access_token: "shared-token", expires_in: 3600 });

    await expect(lead).resolves.toBe("shared-token");
    await expect(follower).resolves.toBe("shared-token");
    expect(refreshCallCount()).toBe(1);
  });

  it("concurrent callers all reject when the refresh fails", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    let rejectRefresh!: (err: unknown) => void;
    mockInvoke({
      get_refresh_token: "rt",
      refresh_google_token: () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    });

    const lead = getValidToken(true);
    const follower = getValidToken(true);

    await vi.waitFor(() => {
      expect(refreshCallCount()).toBe(1);
    });

    rejectRefresh(new Error("invalid_grant: revoked"));

    // Lead converts the failure into a null return; the follower's shared
    // promise rejects so the error propagates as a throw.
    await expect(lead).resolves.toBeNull();
    await expect(follower).rejects.toBeInstanceOf(TokenRefreshError);
    expect(refreshCallCount()).toBe(1);
    // invalid_grant side-effect (auth-logout) fires exactly once, never
    // once per caller.
    const authLogoutCalls = dispatchEventMock().mock.calls.filter(
      ([e]) => (e as Event).type === "auth-logout",
    );
    expect(authLogoutCalls).toHaveLength(1);
  });

  it("lead caller returns null (not throw) when refresh fails", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    let rejectRefresh!: (err: unknown) => void;
    mockInvoke({
      get_refresh_token: "rt",
      refresh_google_token: () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    });

    const lead = getValidToken(true);

    await vi.waitFor(() => {
      expect(refreshCallCount()).toBe(1);
    });

    rejectRefresh(new Error("network unreachable"));

    await expect(lead).resolves.toBeNull();
  });

  it("all callers get empty string when the session changes mid-refresh", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    let releaseRefresh!: (value: unknown) => void;
    mockInvoke({
      get_refresh_token: "rt",
      refresh_google_token: () =>
        new Promise((resolve) => {
          releaseRefresh = resolve;
        }),
    });
    getCurrentSessionIdMock.mockReturnValueOnce(0).mockReturnValueOnce(1);

    const lead = getValidToken(true);
    const follower = getValidToken(true);

    await vi.waitFor(() => {
      expect(refreshCallCount()).toBe(1);
    });

    releaseRefresh({ access_token: "new", expires_in: 3600 });

    await expect(lead).resolves.toBe("");
    await expect(follower).resolves.toBe("");
    expect(storage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(storage.getItem(TOKEN_TIME_KEY)).toBeNull();
  });

  it("refresh starts again after a completed refresh (promise reset)", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    mockInvoke({
      get_refresh_token: "rt",
      refresh_google_token: { access_token: "first", expires_in: 3600 },
    });

    await expect(getValidToken(true)).resolves.toBe("first");
    await expect(getValidToken(true)).resolves.toBe("first");
    expect(refreshCallCount()).toBe(2);
  });
});

// Spec-guards for the bounded-retry upgrade (max attempts + exponential
// backoff, AGENTS.md Luật 4 "không retry vô hạn"): the refresh retry chain
// must stop after the attempt budget instead of retrying forever, back off
// exponentially between attempts, reset its budget on a successful refresh,
// and stay cancellable via stopProactiveRefresh.
describe("scheduleRetryRefresh bounded retry (max attempts + backoff)", () => {
  const refreshCallCount = () =>
    invokeMock.mock.calls.filter((call) => call[0] === "refresh_google_token")
      .length;

  // The retry timer is the only setTimeout in the 30s..120s window (the
  // timeout wrappers use 5s/15s and the proactive timer runs at ~55min), so
  // filtering by delay isolates the retry-timer delays for assertion.
  const retryTimerDelays = (
    calls: ReadonlyArray<readonly unknown[]>,
  ): number[] =>
    calls
      .map((call) => call[1] as number)
      .filter((delay) => delay >= 30_000 && delay <= 120_000);

  const alwaysFailRefresh = () => {
    mockInvoke({
      get_refresh_token: "rt",
      refresh_google_token: () => Promise.reject(new Error("Failed to fetch")),
    });
  };

  it("stops retrying after the max-attempt budget instead of retrying forever", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    alwaysFailRefresh();
    vi.useFakeTimers();
    try {
      await getValidToken(true); // transient failure → schedules the first retry
      // Backoff budget: 30s + 60s + 120s + 120s = 330s, then give-up.
      await vi.advanceTimersByTimeAsync(400_000);
      expect(refreshCallCount()).toBe(5); // 1 initial + 4 retries (RETRY_MAX_ATTEMPTS)
      expect(captureErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("giving up") as unknown as string,
        }),
      );
      // Budget exhausted: no timer is scheduled, so more time changes nothing.
      await vi.advanceTimersByTimeAsync(400_000);
      expect(refreshCallCount()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off exponentially between retries (each delay longer than the last, capped)", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    alwaysFailRefresh();
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn<typeof globalThis, "setTimeout">(
      globalThis,
      "setTimeout",
    );
    try {
      await getValidToken(true); // schedules 30s
      await vi.advanceTimersByTimeAsync(30_000); // retry 1 fires → schedules 60s
      await vi.advanceTimersByTimeAsync(60_000); // retry 2 fires → schedules 120s (capped)
      const delays = retryTimerDelays(setTimeoutSpy.mock.calls);
      expect(delays).toEqual([30_000, 60_000, 120_000]);
      expect(delays[1] ?? 0).toBeGreaterThan(delays[0] ?? 0);
      expect(delays[2] ?? 0).toBeGreaterThan(delays[1] ?? 0);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("resets the retry budget on a successful refresh (next cycle starts at the base delay)", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    let failRefresh = true;
    mockInvoke({
      get_refresh_token: "rt",
      refresh_google_token: () =>
        failRefresh
          ? Promise.reject(new Error("Failed to fetch"))
          : Promise.resolve({ access_token: "ok", expires_in: 3600 }),
    });
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn<typeof globalThis, "setTimeout">(
      globalThis,
      "setTimeout",
    );
    try {
      await getValidToken(true); // fails → schedules retry at 30s
      failRefresh = false; // the scheduled retry now succeeds
      await vi.advanceTimersByTimeAsync(30_000); // retry fires and SUCCEEDS → budget resets
      failRefresh = true;
      await getValidToken(true); // fails again → must schedule at 30s (fresh cycle), not 60s
      const delays = retryTimerDelays(setTimeoutSpy.mock.calls);
      const lastDelay = delays[delays.length - 1];
      expect(lastDelay).toBe(30_000);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stopProactiveRefresh cancels a pending retry timer", async () => {
    storage.setItem(REFRESH_TOKEN_KEY, "rt");
    alwaysFailRefresh();
    vi.useFakeTimers();
    try {
      await getValidToken(true); // schedules a retry at 30s
      stopProactiveRefresh(); // cancels the pending retry timer
      await vi.advanceTimersByTimeAsync(400_000);
      expect(refreshCallCount()).toBe(1); // no retry ever fired
    } finally {
      vi.useRealTimers();
    }
  });
});
