// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppGlobalEvents } from "./useAppGlobalEvents";
import { getValidToken } from "../utils/apiClient";
import { ACCESS_TOKEN_KEY } from "../utils/storageKeys";

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedGetValidToken = vi.mocked(getValidToken);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedGetValidToken.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAppGlobalEvents focus refresh guard (M1c)", () => {
  it("refreshes on focus when only an access token exists (keyring user has no refresh token in localStorage)", () => {
    localStorage.setItem(ACCESS_TOKEN_KEY, "tok-123");
    renderHook(() => {
      useAppGlobalEvents(() => {});
    });

    window.dispatchEvent(new Event("focus"));

    expect(mockedGetValidToken).toHaveBeenCalledTimes(1);
  });

  it("skips the refresh on focus when signed out (no access token)", () => {
    renderHook(() => {
      useAppGlobalEvents(() => {});
    });

    window.dispatchEvent(new Event("focus"));

    expect(mockedGetValidToken).not.toHaveBeenCalled();
  });
});
