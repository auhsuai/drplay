// @vitest-environment jsdom
import "fake-indexeddb/auto";
import type { RefObject } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { useDriveInit } from "./useDriveInit";
import { useDriveStore } from "../store/driveStore";
import {
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  DB_NAV_STATE_KEY,
  FOLDER_HISTORY_KEY,
  ROOT_FOLDER_KEY,
} from "../utils/storageKeys";
import { MY_DRIVE_TAB, ROOT_FOLDER_ID } from "../utils/driveConstants";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { getAppConfig } from "../utils/driveApi";

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

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  await db.syncState.clear();
  useDriveStore.setState({
    appRootFolder: null,
    currentFolderId: ROOT_FOLDER_ID,
    currentFolderName: MY_DRIVE_TAB,
    folderHistory: [],
    sortOption: "name",
  });
  mockedInvoke.mockResolvedValue(undefined);
  mockedGetValidToken.mockResolvedValue("tok");
  mockedFetchWithAuth.mockResolvedValue(makeOkFolderResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDriveInit nav-restore-once guard (bug: token refresh reverts folder)", () => {
  it("does NOT overwrite the folder the user navigated to when the token refreshes", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-A" });
    // Persisted nav state: the app last opened the configured root.
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: { id: "root-A", name: MY_DRIVE_TAB, history: [] },
    });
    const hydratedRef: RefObject<boolean> = { current: false };

    const { rerender } = renderHook(
      ({ token }: { token: string | null }) => {
        useDriveInit({
          accessToken: token,
          isLoggedIn: true,
          hydratedRef,
        });
      },
      { initialProps: { token: "tok1" } },
    );

    // First hydrate restores the persisted folder (root-A).
    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe("root-A");
    });

    // User navigates to folder B after the initial hydrate.
    act(() => {
      useDriveStore.getState().setCurrentFolderId("folder-B");
      useDriveStore.getState().setCurrentFolderName("Folder B");
    });

    // Proactive token refresh (~45 min): same account, same root, new token.
    act(() => {
      rerender({ token: "tok2" });
    });
    // Re-init completed once hydration flips back on (initApp's finally).
    await waitFor(() => {
      expect(hydratedRef.current).toBe(true);
    });

    // Regression: pre-fix the re-init ran initApp's nav restore again and
    // reverted the folder to the stale persisted one (root-A), yanking the
    // user out of folder B.
    expect(hydratedRef.current).toBe(true);
    expect(useDriveStore.getState().currentFolderId).toBe("folder-B");
  });

  it("still restores the persisted folder on the FIRST hydrate", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-A" });
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: { id: "folder-C", name: "Folder C", history: [] },
    });
    const hydratedRef: RefObject<boolean> = { current: false };

    renderHook(() => {
      useDriveInit({
        accessToken: "tok1",
        isLoggedIn: true,
        hydratedRef,
      });
    });

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe("folder-C");
    });
  });

  it("does NOT overwrite the navigated folder on refresh when the fallback localStorage nav is the only restore source", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    localStorage.setItem(CURRENT_FOLDER_ID_KEY, "folder-C");
    localStorage.setItem(CURRENT_FOLDER_NAME_KEY, "Folder C");
    localStorage.setItem(FOLDER_HISTORY_KEY, "[]");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-A" });
    const hydratedRef: RefObject<boolean> = { current: false };

    const { rerender } = renderHook(
      ({ token }: { token: string | null }) => {
        useDriveInit({
          accessToken: token,
          isLoggedIn: true,
          hydratedRef,
        });
      },
      { initialProps: { token: "tok1" } },
    );

    // First hydrate falls back to localStorage and restores folder-C.
    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe("folder-C");
    });

    act(() => {
      useDriveStore.getState().setCurrentFolderId("folder-B");
      useDriveStore.getState().setCurrentFolderName("Folder B");
    });

    act(() => {
      rerender({ token: "tok2" });
    });
    await waitFor(() => {
      expect(hydratedRef.current).toBe(true);
    });

    expect(hydratedRef.current).toBe(true);
    expect(useDriveStore.getState().currentFolderId).toBe("folder-B");
  });
});
