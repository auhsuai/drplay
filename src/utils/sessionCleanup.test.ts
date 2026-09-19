// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionState } from "./sessionCleanup";
import { PLAYER_PERSISTENCE_KEYS } from "./playerPersistence";
import { SORT_OPTION_KEY } from "./storageKeys";
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
  it("removes the playback session from localStorage", () => {
    localStorage.setItem(
      PLAYER_PERSISTENCE_KEYS.session,
      JSON.stringify({ track: { id: "old-track" }, time: 12, duration: 180 }),
    );

    clearSessionState();

    expect(localStorage.getItem(PLAYER_PERSISTENCE_KEYS.session)).toBeNull();
  });

  it("removes drplay_sort_option from localStorage", () => {
    localStorage.setItem(SORT_OPTION_KEY, "name-asc");

    clearSessionState();

    expect(localStorage.getItem(SORT_OPTION_KEY)).toBeNull();
  });

  it("clears sort option (raw string value) alongside last_session", () => {
    localStorage.setItem(
      PLAYER_PERSISTENCE_KEYS.session,
      JSON.stringify({ track: { id: "old-track" } }),
    );
    localStorage.setItem(SORT_OPTION_KEY, "modified-desc");

    clearSessionState();

    expect(localStorage.getItem(PLAYER_PERSISTENCE_KEYS.session)).toBeNull();
    expect(localStorage.getItem(SORT_OPTION_KEY)).toBeNull();
  });

  it("pins the playback persistence key contract", () => {
    expect(PLAYER_PERSISTENCE_KEYS.session).toBe("drplay_last_session");
    expect(PLAYER_PERSISTENCE_KEYS.queue).toBe("drplay_queue");
    expect(PLAYER_PERSISTENCE_KEYS.playMode).toBe("drplay_playmode");
  });

  it("calls kvDel for session, playmode and queue", () => {
    clearSessionState();

    expect(kvDelMock).toHaveBeenCalledTimes(3);
    expect(kvDelMock).toHaveBeenCalledWith(PLAYER_PERSISTENCE_KEYS.session);
    expect(kvDelMock).toHaveBeenCalledWith(PLAYER_PERSISTENCE_KEYS.playMode);
    expect(kvDelMock).toHaveBeenCalledWith(PLAYER_PERSISTENCE_KEYS.queue);
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
        level: "warn",
        source: "playerPersistence",
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

      // Both halves report independently: the playback lanes (module) and the
      // sort preference (sessionCleanup) each log their own storage failure.
      expect(captureErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "playerPersistence",
          message: expect.stringContaining(
            "localStorage cleanup failed",
          ) as unknown as string,
        }),
      );
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
