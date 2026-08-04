// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { useTauriEvents } from "./useTauriEvents";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const listenMock = vi.mocked(listen);

let quotaHandler: (() => void) | null = null;
let isListening = false;

function resetListenMock() {
  quotaHandler = null;
  isListening = false;
  listenMock.mockImplementation((event: string, handler: unknown) => {
    if (event === "drive-quota-exceeded") {
      isListening = true;
      const cb = handler as () => void;
      quotaHandler = () => {
        if (isListening) cb();
      };
    }
    // Mirrors the real contract: after unlisten() the backend stops emitting.
    return Promise.resolve(() => {
      isListening = false;
    });
  });
}

async function fireQuota() {
  if (!quotaHandler)
    throw new Error(
      "drive-quota-exceeded handler not registered — mount the hook first",
    );
  await act(async () => {
    quotaHandler!();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetListenMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useTauriEvents drive-quota-exceeded listener", () => {
  it("registers the quota listener and opens the rate-limit modal when the backend event fires", async () => {
    const setShowRateLimitModal = vi.fn();

    renderHook(() => useTauriEvents(setShowRateLimitModal));
    expect(listenMock).toHaveBeenCalledWith(
      "drive-quota-exceeded",
      expect.any(Function),
    );

    await fireQuota();

    expect(setShowRateLimitModal).toHaveBeenCalledTimes(1);
    expect(setShowRateLimitModal).toHaveBeenCalledWith(true);
  });

  it("unregisters the listener and does not fire after unmount", async () => {
    const setShowRateLimitModal = vi.fn();

    const { unmount } = renderHook(() => useTauriEvents(setShowRateLimitModal));
    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    await fireQuota();
    expect(setShowRateLimitModal).not.toHaveBeenCalled();
  });
});
