// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getValidToken } from "../utils/apiClient";
import { captureError } from "../utils/errorLog";
import { useServiceWorker } from "./useServiceWorker";

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedGetValidToken = vi.mocked(getValidToken);
const mockedCaptureError = vi.mocked(captureError);

type SwContainerListener = (event: MessageEvent) => void;

const swListeners = new Map<string, SwContainerListener>();

beforeEach(() => {
  swListeners.clear();
  vi.clearAllMocks();
  const register = vi
    .fn()
    .mockResolvedValue({ addEventListener: vi.fn(), installing: null });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: (type: string, handler: SwContainerListener) => {
        swListeners.set(type, handler);
      },
      removeEventListener: (type: string) => {
        swListeners.delete(type);
      },
      register,
      controller: { postMessage: vi.fn() },
      ready: Promise.resolve({ active: { postMessage: vi.fn() } }),
    },
  });
});

describe("useServiceWorker SW_TOKEN_EXPIRED listener", () => {
  it("forces a token refresh when the SW reports SW_TOKEN_EXPIRED", async () => {
    mockedGetValidToken.mockResolvedValue("fresh-token");
    renderHook(() => useServiceWorker());

    await act(async () => {
      swListeners.get("message")?.({
        data: { type: "SW_TOKEN_EXPIRED" },
      } as MessageEvent);
    });

    expect(mockedGetValidToken).toHaveBeenCalledWith(true);
  });

  it("ignores messages that are not SW_TOKEN_EXPIRED", async () => {
    renderHook(() => useServiceWorker());

    await act(async () => {
      swListeners.get("message")?.({
        data: { type: "UPDATE_TOKEN", token: "x" },
      } as MessageEvent);
    });

    expect(mockedGetValidToken).not.toHaveBeenCalled();
  });

  it("captures refresh failures without logging the token", async () => {
    mockedGetValidToken.mockRejectedValue(
      new Error("refresh backend unreachable"),
    );
    renderHook(() => useServiceWorker());

    await act(async () => {
      swListeners.get("message")?.({
        data: { type: "SW_TOKEN_EXPIRED" },
      } as MessageEvent);
    });

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useServiceWorker",
        message: expect.stringContaining(
          "sw-token-expired-refresh-failed",
        ) as unknown as string,
      }),
    );
  });

  it("removes the message listener on unmount", async () => {
    const { unmount } = renderHook(() => useServiceWorker());
    expect(swListeners.has("message")).toBe(true);
    unmount();
    expect(swListeners.has("message")).toBe(false);
  });
});
