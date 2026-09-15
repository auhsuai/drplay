// Regression tests for the post-logout persistence window in getValidToken
// (B11 CROSS-FILE #1): the session is checked BEFORE the awaited keyring write,
// so a logout that starts while writeRefreshToken is in flight used to be
// followed by scheduleProactiveRefresh + a token-updated broadcast of a token
// that belongs to a dead session — re-arming the proactive timer and leaving
// the rotated refresh credential as keyring residue after logout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getValidToken, stopProactiveRefresh } from "./tokenRefresh";
import {
  deleteRefreshToken,
  readRefreshToken,
  writeRefreshToken,
} from "./refreshTokenStore";
import { getCurrentSessionId } from "./sessionGuard";
import { ACCESS_TOKEN_KEY } from "./storageKeys";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./sessionGuard", () => ({
  getCurrentSessionId: vi.fn(),
  invalidateCurrentSession: vi.fn(),
}));

// The keyring boundary is mocked so the test controls exactly when the awaited
// write settles (the window under test). REFRESH_TIMEOUT_MS comes from the same
// module (tokenRefresh.ts imports it), so the mock must carry it too.
vi.mock("./refreshTokenStore", () => ({
  readRefreshToken: vi.fn(),
  writeRefreshToken: vi.fn(),
  deleteRefreshToken: vi.fn(),
  REFRESH_TIMEOUT_MS: 15_000,
}));

// captureError is a no-op mock so refresh-failure paths never touch the
// dexie/IndexedDB layer (node test environment).
vi.mock("./errorLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./errorLog")>();
  return {
    ...actual,
    captureError: vi.fn().mockResolvedValue(undefined),
  };
});

const invokeMock = vi.mocked(invoke);
const readRefreshTokenMock = vi.mocked(readRefreshToken);
const writeRefreshTokenMock = vi.mocked(writeRefreshToken);
const deleteRefreshTokenMock = vi.mocked(deleteRefreshToken);
const getCurrentSessionIdMock = vi.mocked(getCurrentSessionId);

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

function dispatchEventMock(): ReturnType<typeof vi.fn> {
  return (
    globalThis as unknown as {
      window: { dispatchEvent: ReturnType<typeof vi.fn> };
    }
  ).window.dispatchEvent;
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    makeStorage();
  (
    globalThis as unknown as { window: { dispatchEvent: (e: Event) => void } }
  ).window = {
    dispatchEvent: vi.fn(),
  };
  invokeMock.mockReset();
  readRefreshTokenMock.mockReset();
  writeRefreshTokenMock.mockReset();
  deleteRefreshTokenMock.mockReset();
  getCurrentSessionIdMock.mockReset();
  getCurrentSessionIdMock.mockReturnValue(0);
  deleteRefreshTokenMock.mockResolvedValue(undefined);
});

afterEach(() => {
  stopProactiveRefresh();
  vi.useRealTimers();
});

describe("getValidToken post-logout session re-check (B11 CROSS-FILE #1)", () => {
  it("drops the refresh when logout starts while writeRefreshToken is in flight (no token-updated, no re-arm, credential cleaned)", async () => {
    readRefreshTokenMock.mockResolvedValue("rt-old");
    let releaseWrite!: () => void;
    writeRefreshTokenMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );
    invokeMock.mockResolvedValue({
      access_token: "acc-new",
      refresh_token: "rt-new",
      expires_in: 3600,
    });

    vi.useFakeTimers();
    const tokenPromise = getValidToken(true);

    // Flush microtasks until the flow is suspended on the keyring write.
    for (
      let i = 0;
      i < 10 && writeRefreshTokenMock.mock.calls.length === 0;
      i += 1
    ) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(writeRefreshTokenMock).toHaveBeenCalledWith("rt-new");
    // Two checks have run so far: the flight-start capture and the pre-write
    // check — the write is suspended with no third check yet.
    expect(getCurrentSessionIdMock).toHaveBeenCalledTimes(2);

    // Logout begins mid-write: the session id changes while the vault write
    // is still pending.
    getCurrentSessionIdMock.mockReturnValue(1);
    releaseWrite();

    await expect(tokenPromise).resolves.toBe("");
    // The post-write re-check ran (third call) — the window is closed.
    expect(getCurrentSessionIdMock).toHaveBeenCalledTimes(3);
    // The rotated credential written during the logout window must not stay
    // in the keyring, and it must be removed AFTER the write (not before).
    expect(deleteRefreshTokenMock).toHaveBeenCalledTimes(1);
    expect(deleteRefreshTokenMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      writeRefreshTokenMock.mock.invocationCallOrder[0] ?? 0,
    );
    // No stale broadcast and no proactive timer re-armed for a dead session.
    expect(dispatchEventMock()).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the happy path: session unchanged → token returned and token-updated broadcast", async () => {
    readRefreshTokenMock.mockResolvedValue("rt-old");
    writeRefreshTokenMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue({
      access_token: "acc-new",
      refresh_token: "rt-new",
      expires_in: 3600,
    });

    vi.useFakeTimers();
    await expect(getValidToken(true)).resolves.toBe("acc-new");

    expect(writeRefreshTokenMock).toHaveBeenCalledWith("rt-new");
    expect(deleteRefreshTokenMock).not.toHaveBeenCalled();
    expect(dispatchEventMock()).toHaveBeenCalledTimes(1);
    const event = dispatchEventMock().mock.calls[0]?.[0] as
      CustomEvent<{ token: string }> | undefined;
    expect(event?.detail.token).toBe("acc-new");
    // Happy path still arms the proactive refresh (one pending timer).
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("getValidToken session check before persisting (regression guard)", () => {
  it("does not persist or broadcast when the session changed while the refresh was in flight (pre-write check)", async () => {
    readRefreshTokenMock.mockResolvedValue("rt-old");
    writeRefreshTokenMock.mockResolvedValue(undefined);
    let releaseInvoke!: (value: unknown) => void;
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseInvoke = resolve;
        }),
    );
    getCurrentSessionIdMock.mockReturnValue(0);

    vi.useFakeTimers();
    const tokenPromise = getValidToken(true);
    for (let i = 0; i < 10 && invokeMock.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Logout lands while the Google refresh call is still in flight.
    getCurrentSessionIdMock.mockReturnValue(1);
    releaseInvoke({
      access_token: "acc-new",
      refresh_token: "rt-new",
      expires_in: 3600,
    });

    await expect(tokenPromise).resolves.toBe("");
    expect(writeRefreshTokenMock).not.toHaveBeenCalled();
    expect(deleteRefreshTokenMock).not.toHaveBeenCalled();
    expect(dispatchEventMock()).not.toHaveBeenCalled();
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
        ACCESS_TOKEN_KEY,
      ),
    ).toBeNull();
  });
});
