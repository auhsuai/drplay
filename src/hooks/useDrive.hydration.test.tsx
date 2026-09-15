// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { useDrive } from "./useDrive";
import { useDriveStore } from "../store/driveStore";
import { ROOT_FOLDER_KEY } from "../utils/storageKeys";
import { MY_DRIVE_TAB, ROOT_FOLDER_ID } from "../utils/driveConstants";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { getAppConfig, saveAppConfig } from "../utils/driveApi";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

vi.mock("../utils/driveApi", () => ({
  getAppConfig: vi.fn(),
  saveAppConfig: vi.fn(),
  FOLDER_MIME: "application/vnd.google-apps.folder",
}));

vi.mock("../utils/cache", () => ({
  CLEAR_LOCAL_CACHE_CMD: "clear_local_cache",
}));

vi.mock("../utils/history", () => ({
  recordFolderVisit: vi.fn(),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedFetchWithAuth = vi.mocked(fetchWithAuth);
const mockedGetAppConfig = vi.mocked(getAppConfig);
const mockedSaveAppConfig = vi.mocked(saveAppConfig);

function makeOkFolderResponse() {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        id: "root-A",
        name: "Root A",
        mimeType: "application/vnd.google-apps.folder",
      }),
  } as unknown as Response;
}

// Deferred getAppConfig: holds the init run inside its network verify so the
// tests can observe isHydrated while the "network" is still in flight.
let resolveConfig: (v: Record<string, unknown> | null) => void = () => {};
function deferredConfig() {
  return new Promise<Record<string, unknown> | null>((resolve) => {
    resolveConfig = resolve;
  });
}

const settle = async (value: Record<string, unknown> | null) => {
  await act(async () => {
    resolveConfig(value);
    await new Promise((r) => setTimeout(r, 20));
  });
};

type DriveProps = { isLoggedIn: boolean; token: string | null };

const renderDrive = () =>
  renderHook<ReturnType<typeof useDrive>, DriveProps>(
    ({ isLoggedIn, token }) => useDrive(isLoggedIn, token),
    {
      initialProps: { isLoggedIn: true, token: "tok1" },
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useDriveStore.setState({
    appRootFolder: null,
    currentFolderId: ROOT_FOLDER_ID,
    currentFolderName: MY_DRIVE_TAB,
    folderHistory: [],
    sortOption: "name",
    isHydrated: false,
  });
  mockedInvoke.mockResolvedValue(undefined);
  mockedGetValidToken.mockResolvedValue("tok");
  mockedFetchWithAuth.mockResolvedValue(makeOkFolderResponse());
  mockedSaveAppConfig.mockResolvedValue(true);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await db.files.clear();
  await db.syncState.clear();
});

describe("useDrive hydration flag (P2-04-8)", () => {
  it("isHydrated stays false while the root verify is in flight, flips true when init settles", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockImplementationOnce(() => deferredConfig());

    renderDrive();

    await waitFor(() => {
      expect(mockedGetAppConfig).toHaveBeenCalledTimes(1);
    });
    // getAppConfig has not resolved: the picker must stay gated.
    expect(useDriveStore.getState().isHydrated).toBe(false);

    await settle({ rootFolderId: "root-A" });
    await waitFor(() => {
      expect(useDriveStore.getState().isHydrated).toBe(true);
    });
  });

  it("re-login after logout resets hydration: false during the re-verify, true when it settles", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValueOnce({ rootFolderId: "root-A" });

    const { rerender } = renderDrive();
    await waitFor(() => {
      expect(useDriveStore.getState().isHydrated).toBe(true);
    });

    // Logout: App's logout-cleanup removes the root key and the drive effect
    // clears appRootFolder (App.tsx logout path).
    localStorage.removeItem(ROOT_FOLDER_KEY);
    rerender({ isLoggedIn: false, token: null });
    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBeNull();
    });

    // Login again: the verify is pending, so the flag must be false again —
    // otherwise the gate paints the picker over a session that HAS a root.
    mockedGetAppConfig.mockImplementationOnce(() => deferredConfig());
    rerender({ isLoggedIn: true, token: "tok2" });
    await waitFor(() => {
      expect(mockedGetAppConfig).toHaveBeenCalledTimes(2);
    });
    expect(useDriveStore.getState().isHydrated).toBe(false);

    await settle({ rootFolderId: "root-A" });
    await waitFor(() => {
      expect(useDriveStore.getState().isHydrated).toBe(true);
    });
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
  });

  it("a mid-session token rotation does NOT reset the flag (no gate blink on re-init)", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValueOnce({ rootFolderId: "root-A" });

    const { rerender } = renderDrive();
    await waitFor(() => {
      expect(useDriveStore.getState().isHydrated).toBe(true);
    });

    mockedGetAppConfig.mockImplementationOnce(() => deferredConfig());
    rerender({ isLoggedIn: true, token: "tok2" });
    await waitFor(() => {
      expect(mockedGetAppConfig).toHaveBeenCalledTimes(2);
    });
    // The re-verify keeps the previous root (B12-1): the gate must stay settled.
    expect(useDriveStore.getState().isHydrated).toBe(true);

    await settle({ rootFolderId: "root-A" });
    expect(useDriveStore.getState().isHydrated).toBe(true);
  });
});
