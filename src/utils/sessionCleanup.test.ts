// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_CLEANUP_KEYS, clearSessionState } from "./sessionCleanup";
import { del as kvDel } from "../db/kv";
import { captureError } from "./errorLog";

vi.mock("../db/kv", () => ({ del: vi.fn() }));
vi.mock("./errorLog", () => ({ captureError: vi.fn() }));

const kvDelMock = vi.mocked(kvDel);
const captureErrorMock = vi.mocked(captureError);

beforeEach(() => {
  kvDelMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("clearSessionState", () => {
  it("removes drplay_last_session from localStorage", () => {
    localStorage.setItem(
      SESSION_CLEANUP_KEYS.lastSessionLocalStorage,
      JSON.stringify({ track: { id: "old-track" }, time: 12, duration: 180 }),
    );

    clearSessionState();

    expect(
      localStorage.getItem(SESSION_CLEANUP_KEYS.lastSessionLocalStorage),
    ).toBeNull();
  });

  it("removes drplay_sort_option from localStorage", () => {
    localStorage.setItem(
      SESSION_CLEANUP_KEYS.sortOptionLocalStorage,
      "name-asc",
    );

    clearSessionState();

    expect(
      localStorage.getItem(SESSION_CLEANUP_KEYS.sortOptionLocalStorage),
    ).toBeNull();
  });

  it("clears sort option (raw string value) alongside last_session", () => {
    localStorage.setItem(
      SESSION_CLEANUP_KEYS.lastSessionLocalStorage,
      JSON.stringify({ track: { id: "old-track" } }),
    );
    localStorage.setItem(
      SESSION_CLEANUP_KEYS.sortOptionLocalStorage,
      "modified-desc",
    );

    clearSessionState();

    expect(
      localStorage.getItem(SESSION_CLEANUP_KEYS.lastSessionLocalStorage),
    ).toBeNull();
    expect(
      localStorage.getItem(SESSION_CLEANUP_KEYS.sortOptionLocalStorage),
    ).toBeNull();
  });

  it("calls kvDel for last_session, playmode and queue", () => {
    clearSessionState();

    expect(kvDelMock).toHaveBeenCalledTimes(3);
    expect(kvDelMock).toHaveBeenCalledWith(SESSION_CLEANUP_KEYS.lastSessionKv);
    expect(kvDelMock).toHaveBeenCalledWith(SESSION_CLEANUP_KEYS.playModeKv);
    expect(kvDelMock).toHaveBeenCalledWith(SESSION_CLEANUP_KEYS.queueKv);
  });

  it("captures the failure via captureError when a kvDel rejects, without throwing", async () => {
    kvDelMock.mockRejectedValueOnce(new Error("kv-store-unavailable"));

    expect(() => {
      clearSessionState();
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledTimes(1);
    });

    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "sessionCleanup",
        kind: "logout-cleanup-failed",
        message: expect.stringContaining(
          "kv-store-unavailable",
        ) as unknown as string,
      }),
    );
  });

  it("is a safe no-op when no session keys exist yet", async () => {
    expect(() => {
      clearSessionState();
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(captureErrorMock).not.toHaveBeenCalled();
    });

    expect(kvDelMock).toHaveBeenCalledTimes(3);
  });

  it("does not throw when localStorage.removeItem throws (SecurityError) and captures the failure", async () => {
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      });

    try {
      expect(() => {
        clearSessionState();
      }).not.toThrow();

      await vi.waitFor(() => {
        expect(captureErrorMock).toHaveBeenCalled();
      });

      expect(captureErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "sessionCleanup",
          message: expect.stringContaining(
            "localStorage cleanup failed",
          ) as unknown as string,
        }),
      );
    } finally {
      removeItemSpy.mockRestore();
    }
  });
});
