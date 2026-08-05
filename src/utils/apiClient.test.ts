import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  fetchWithAuth,
  getValidToken,
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
    getItem: (k: string) => (k in s ? s[k] : null),
    setItem: (k: string, v: string) => {
      s[k] = v;
    },
    removeItem: (k: string) => {
      s = Object.fromEntries(
        Object.entries(s).filter(([key]) => key !== k),
      );
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

beforeEach(() => {
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
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
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
    const retryOpts = fetchSpy.mock.calls[1][1] as RequestInit;
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
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
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
    const firstSignal = (fetchSpy.mock.calls[0][1] as RequestInit).signal;
    const retrySignal = (fetchSpy.mock.calls[1][1] as RequestInit).signal;
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
    expect(anySpy).toHaveBeenCalledWith([
      controller.signal,
      timeoutSpy.mock.results[0].value,
    ]);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBe(anySpy.mock.results[0].value);
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

  it("(e) keeps the refresh token in localStorage and logs when the keyring write fails", async () => {
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
    expect(storage.getItem(REFRESH_TOKEN_KEY)).toBe("rt-new");
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
