// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { useDrive } from "./useDrive";
import { useDriveStore } from "../store/driveStore";
import { ROOT_FOLDER_KEY } from "../utils/storageKeys";
import { MY_DRIVE_TAB, ROOT_FOLDER_ID } from "../utils/driveConstants";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { getAppConfig, saveAppConfig } from "../utils/driveApi";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";

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
  mergeWithTimeoutSignal: (signal: AbortSignal) => signal,
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

const waitForInit = () => {
  return waitFor(() => {
    expect(useDriveStore.getState().appRootFolder).not.toBeNull();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
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
  mockedSaveAppConfig.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDrive initApp root-change guard (B-regression: unconditional db.files.clear)", () => {
  it("does NOT clear the local file cache when the token refreshes but the remote root is unchanged", async () => {
    // First login with root "root-A" already saved locally and in the
    // remote config: nothing changed, so no cache wipe may happen.
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-A" });
    const clearSpy = vi.spyOn(db.files, "clear");

    const { rerender } = renderHook(
      ({ token }: { token: string | null }) => useDrive(true, token),
      { initialProps: { token: "tok1" } },
    );

    await waitForInit();

    // Simulate the ~45-min proactive token refresh: same account, same
    // root folder, only the access token changed.
    act(() => {
      rerender({ token: "tok2" });
    });
    await waitForInit();

    // Regression: pre-fix the effect re-ran initApp on every token refresh
    // and cleared db.files unconditionally (git 6bcaee), making the My Drive
    // listing vanish until the next fetch. A same-root re-init must be a no-op.
    expect(clearSpy).toHaveBeenCalledTimes(0);
    expect(mockedInvoke).not.toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
  });

  it("clears the local file cache when the remote root folder CHANGES", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-B" });
    const clearSpy = vi.spyOn(db.files, "clear");

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBe("root-B");
    });

    // Switching the configured root invalidates the cached listing: clearing
    // is still required in this case (original ed12e81 behavior).
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
  });
});
