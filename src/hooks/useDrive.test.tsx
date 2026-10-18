// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { wipeFileRowsForUser } from "../db/fileRows";
import { useDrive } from "./useDrive";
import { useDriveStore } from "../store/driveStore";
import {
  ROOT_FOLDER_KEY,
  ROOT_FOLDERS_KEY,
  USER_EMAIL_KEY,
  DB_NAV_STATE_KEY,
} from "../utils/storageKeys";
import {
  MY_DRIVE_TAB,
  ROOT_FOLDER_ID,
  VIRTUAL_ROOT_ID,
  VIRTUAL_ROOT_NAME,
} from "../utils/driveConstants";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { getAppConfig, saveAppConfig } from "../utils/driveApi";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { captureError } from "../utils/errorLog";

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

// Partial mock: every other fileRows helper stays real, but the wipe becomes
// observable. The mock calls through to the real account-scoped delete, so the
// isolation assertions exercise the actual Dexie query.
vi.mock("../db/fileRows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/fileRows")>();
  return {
    ...actual,
    wipeFileRowsForUser: vi.fn(actual.wipeFileRowsForUser),
  };
});

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
const mockedWipeFileRowsForUser = vi.mocked(wipeFileRowsForUser);
const mockedCaptureError = vi.mocked(captureError);

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

const FOLDER_MIME = "application/vnd.google-apps.folder";

function okFolderResponse(name: string, extra?: Record<string, unknown>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        name,
        mimeType: FOLDER_MIME,
        ...extra,
      }),
  } as unknown as Response;
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function mockVerifyByRootId(byId: Record<string, Response>) {
  mockedFetchWithAuth.mockImplementation((url) => {
    const urlText = typeof url === "string" ? url : url.url;
    const rootId = Object.keys(byId).find((id) =>
      urlText.includes(`/files/${encodeURIComponent(id)}?`),
    );
    const response = rootId === undefined ? undefined : byId[rootId];
    if (response === undefined) {
      return Promise.reject(new Error(`unexpected verify url: ${urlText}`));
    }
    return Promise.resolve(response);
  });
}

const seedLocalRoots = (
  roots: { id: string; name: string }[],
  primary: string,
) => {
  localStorage.setItem(ROOT_FOLDERS_KEY, JSON.stringify(roots));
  localStorage.setItem(ROOT_FOLDER_KEY, primary);
};

const readStoredRoots = (): unknown => {
  const raw = localStorage.getItem(ROOT_FOLDERS_KEY);
  return raw === null ? null : JSON.parse(raw);
};

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
    rootFolders: [],
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

afterEach(async () => {
  // No vitest globals -> RTL has no auto-cleanup: without this, hooks stay
  // mounted across tests and keep writing the SHARED zustand store / syncState.
  cleanup();
  vi.restoreAllMocks();
  await db.files.clear();
  await db.syncState.clear();
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
    // listing vanish until the next fetch. A same-root re-init must be a
    // no-op: re-verify the config, but keep the cache AND the live nav state
    // (B12-1: no hydratedRef reset, no nav restore; transient verify failures
    // keep the previous root).
    expect(clearSpy).toHaveBeenCalledTimes(0);
    expect(mockedWipeFileRowsForUser).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
  });

  it("wipes ONLY the current account's rows when the remote root folder CHANGES", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    localStorage.setItem(USER_EMAIL_KEY, "a@x");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-B" });
    const clearSpy = vi.spyOn(db.files, "clear");

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBe("root-B");
    });

    // Switching the configured root invalidates the cached listing, but the
    // invalidation is account-scoped: the whole-store clear would destroy
    // every OTHER account's mirror too.
    expect(mockedWipeFileRowsForUser).toHaveBeenCalledTimes(1);
    expect(mockedWipeFileRowsForUser).toHaveBeenCalledWith("a@x");
    expect(clearSpy).toHaveBeenCalledTimes(0);
    expect(mockedInvoke).toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
  });

  it("keeps OTHER accounts' mirrors when the remote root folder changes (2-account isolation)", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    localStorage.setItem(USER_EMAIL_KEY, "a@x");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-B" });
    await db.files.bulkPut([
      {
        id: "mine",
        name: "mine.mp3",
        mimeType: "audio/mpeg",
        parentId: "root-A",
        trashed: false,
        isFolder: false,
        userEmail: "a@x",
      },
      {
        id: "theirs",
        name: "theirs.mp3",
        mimeType: "audio/mpeg",
        parentId: "root-A",
        trashed: false,
        isFolder: false,
        userEmail: "b@x",
      },
    ]);

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBe("root-B");
    });

    expect(mockedWipeFileRowsForUser).toHaveBeenCalledWith("a@x");
    expect(await db.files.get(["a@x", "mine"])).toBeUndefined();
    expect(await db.files.get(["b@x", "theirs"])).toBeDefined();
  });

  it("falls back to the legacy full clear while the owner is still the sentinel", async () => {
    // No USER_EMAIL_KEY: getCurrentUserEmail() returns the "default" sentinel,
    // so legacy rows have no real account fingerprint and the store-wide clear
    // is preserved for this branch.
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-B" });
    const clearSpy = vi.spyOn(db.files, "clear");

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBe("root-B");
    });

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(mockedWipeFileRowsForUser).not.toHaveBeenCalled();
  });
});

describe("useDrive initApp re-init & user race (B12)", () => {
  it("keeps nav state the user changed mid-window when the token rotates and the config resolves (B12-1)", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: { id: "old-folder", name: "Old Folder", history: [] },
    });
    let resolveConfig: (v: Record<string, unknown> | null) => void = () => {};
    mockedGetAppConfig
      .mockResolvedValueOnce({ rootFolderId: "root-A" })
      .mockImplementationOnce(
        () =>
          new Promise<Record<string, unknown> | null>((resolve) => {
            resolveConfig = resolve;
          }),
      );

    const { rerender } = renderHook(
      ({ token }: { token: string | null }) => useDrive(true, token),
      { initialProps: { token: "tok1" } },
    );

    // First init restores the persisted nav position ("old-folder").
    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe("old-folder");
    });

    // Proactive token rotation: the re-verify's getAppConfig is now pending.
    act(() => {
      rerender({ token: "tok2" });
    });
    await waitFor(() => {
      expect(mockedGetAppConfig).toHaveBeenCalledTimes(2);
    });

    // The user navigates while the re-init window is open.
    act(() => {
      useDriveStore.getState().setCurrentFolderId("folder-X");
    });

    // Remote config resolves with the SAME root: the re-init must not re-apply
    // the persisted snapshot over the live navigation.
    await act(async () => {
      resolveConfig({ rootFolderId: "root-A" });
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(useDriveStore.getState().currentFolderId).toBe("folder-X");
  });

  it("keeps the previous app root when the re-verify request fails transiently on token rotation (B12-1)", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-A" });

    const { rerender } = renderHook(
      ({ token }: { token: string | null }) => useDrive(true, token),
      { initialProps: { token: "tok1" } },
    );
    await waitForInit();

    // Token rotation: the re-verify request rejects (network/timeout).
    mockedFetchWithAuth.mockRejectedValue(new Error("network down"));

    act(() => {
      rerender({ token: "tok2" });
    });

    // The rejection is handled (logged)...
    await waitFor(() => {
      expect(mockedCaptureError).toHaveBeenCalled();
    });

    // ...and must NOT null the root: that would open the folder gate mid-session
    // on a transient network blip.
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
  });

  it("lets a root the user picked mid-init win over the in-flight remote config (B12-3)", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    let resolveConfig: (v: Record<string, unknown> | null) => void = () => {};
    mockedGetAppConfig.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown> | null>((resolve) => {
          resolveConfig = resolve;
        }),
    );

    const { result } = renderHook(() => useDrive(true, "tok1"));
    await waitFor(() => {
      expect(mockedGetAppConfig).toHaveBeenCalledTimes(1);
    });

    // User changes the root (Settings -> Change folder) while init is in flight.
    await act(async () => {
      await result.current.handleSelectRootFolder("root-B");
    });
    expect(useDriveStore.getState().appRootFolder).toBe("root-B");

    // The pending remote config still reports the OLD root.
    await act(async () => {
      resolveConfig({ rootFolderId: "root-A" });
      await new Promise((r) => setTimeout(r, 50));
    });

    // The user's selection must not be reverted (state nor localStorage).
    expect(useDriveStore.getState().appRootFolder).toBe("root-B");
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-B");
  });

  it("lands on the new remote root instead of restoring nav from the old root (B12-5)", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    localStorage.setItem(USER_EMAIL_KEY, "a@x");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-B" });
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: {
        id: "old-folder",
        name: "Old Folder",
        history: [{ id: "root-A", name: MY_DRIVE_TAB }],
      },
    });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBe("root-B");
    });
    // The persisted nav points inside the OLD root: it must be discarded.
    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe("root-B");
    });

    expect(useDriveStore.getState().currentFolderName).toBe(MY_DRIVE_TAB);
    expect(useDriveStore.getState().folderHistory).toEqual([]);
  });
});

describe("useDrive initApp multi-root load, verify and landing (Slice B)", () => {
  let resolveConfig: (v: Record<string, unknown> | null) => void = () => {};
  const deferredConfig = () =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      resolveConfig = resolve;
    });
  const settlePendingConfig = async (value: Record<string, unknown> | null) => {
    await act(async () => {
      resolveConfig(value);
      await new Promise((r) => setTimeout(r, 50));
    });
  };
  const settleAfter = async (ms: number) => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };

  it("migrates a remote legacy single root and refreshes its real name", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-A" });
    mockVerifyByRootId({ "root-A": okFolderResponse("Verified A") });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().rootFolders).toEqual([
        { id: "root-A", name: "Verified A" },
      ]);
    });
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    expect(useDriveStore.getState().currentFolderId).toBe("root-A");
    expect(useDriveStore.getState().currentFolderName).toBe(MY_DRIVE_TAB);
  });

  it("loads a remote two-root list, verifies each name, and lands on the virtual root", async () => {
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "root-A",
      rootFolders: [
        { id: "root-A", name: "Stale A" },
        { id: "root-B", name: "Stale B" },
      ],
    });
    mockVerifyByRootId({
      "root-A": okFolderResponse("Music"),
      "root-B": okFolderResponse("Archive"),
    });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    });
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "root-A", name: "Music" },
      { id: "root-B", name: "Archive" },
    ]);
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    expect(useDriveStore.getState().currentFolderName).toBe(VIRTUAL_ROOT_NAME);
    expect(mockedFetchWithAuth).toHaveBeenCalledTimes(2);
    expect(
      mockedFetchWithAuth.mock.calls.every(([url]) => {
        const urlText = typeof url === "string" ? url : url.url;
        return !urlText.includes(VIRTUAL_ROOT_ID);
      }),
    ).toBe(true);
  });

  it("verifies all 5 roots and preserves their order", async () => {
    const ids = ["r1", "r2", "r3", "r4", "r5"];
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "r1",
      rootFolders: ids.map((id) => ({ id, name: `Old ${id}` })),
    });
    mockVerifyByRootId(
      Object.fromEntries(ids.map((id) => [id, okFolderResponse(`New ${id}`)])),
    );

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().rootFolders).toHaveLength(5);
    });
    expect(useDriveStore.getState().rootFolders).toEqual(
      ids.map((id) => ({ id, name: `New ${id}` })),
    );
    expect(mockedFetchWithAuth).toHaveBeenCalledTimes(5);
  });

  it.each([
    [
      "6 entries",
      Array.from({ length: 6 }, (_, i) => ({
        id: `r${String(i)}`,
        name: `R${String(i)}`,
      })),
    ],
    [
      "duplicate ids",
      [
        { id: "dup", name: "One" },
        { id: "dup", name: "Two" },
      ],
    ],
    [
      "a malformed entry",
      [
        { id: "ok", name: "Ok" },
        { id: 42, name: "Bad" },
      ],
    ],
  ])(
    "falls back to the legacy single root when rootFolders has %s",
    async (_label, badList) => {
      mockedGetAppConfig.mockResolvedValue({
        rootFolderId: "root-L",
        rootFolderName: "Legacy",
        rootFolders: badList,
      });
      mockVerifyByRootId({
        "root-L": okFolderResponse("Legacy real"),
      });

      renderHook(() => useDrive(true, "tok1"));

      await waitFor(() => {
        expect(useDriveStore.getState().rootFolders).toEqual([
          { id: "root-L", name: "Legacy real" },
        ]);
      });
      expect(useDriveStore.getState().appRootFolder).toBe("root-L");
      expect(useDriveStore.getState().currentFolderId).toBe("root-L");
      expect(mockedCaptureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining(
            "config-root-folders-invalid",
          ) as unknown as string,
        }),
      );
    },
  );

  it("falls back to the single local root when the local root list JSON is corrupt", async () => {
    localStorage.setItem(ROOT_FOLDERS_KEY, "{not-json");
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    mockedGetAppConfig.mockResolvedValue(null);
    mockVerifyByRootId({ "root-A": okFolderResponse("Real A") });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().rootFolders).toEqual([
        { id: "root-A", name: "Real A" },
      ]);
    });
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    expect(useDriveStore.getState().currentFolderId).toBe("root-A");
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "root-folders-parse",
        ) as unknown as string,
      }),
    );
  });

  it.each([
    ["a 404", errorResponse(404)],
    [
      "a non-folder mimeType",
      okFolderResponse("B", { mimeType: "text/plain" }),
    ],
    ["a Shared Drive folder", okFolderResponse("B", { driveId: "drive-7" })],
  ])(
    "keeps only the verified primary when a secondary root returns %s",
    async (_label, badResponse) => {
      seedLocalRoots(
        [
          { id: "root-A", name: "A" },
          { id: "root-B", name: "B" },
        ],
        "root-A",
      );
      mockedGetAppConfig.mockResolvedValue({
        rootFolderId: "root-A",
        rootFolders: [
          { id: "root-A", name: "A" },
          { id: "root-B", name: "B" },
        ],
      });
      mockVerifyByRootId({
        "root-A": okFolderResponse("Verified A"),
        "root-B": badResponse,
      });

      renderHook(() => useDrive(true, "tok1"));

      await waitFor(() => {
        expect(useDriveStore.getState().appRootFolder).toBe("root-A");
      });
      await settleAfter(20);
      expect(useDriveStore.getState().rootFolders).toEqual([
        { id: "root-A", name: "Verified A" },
      ]);
      expect(useDriveStore.getState().currentFolderId).toBe("root-A");
      expect(useDriveStore.getState().currentFolderName).toBe(MY_DRIVE_TAB);
      expect(mockedCaptureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining(
            "verify-roots-partial",
          ) as unknown as string,
        }),
      );
    },
  );

  it("gates (null root) when the primary root cannot be verified", async () => {
    seedLocalRoots(
      [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
      "root-A",
    );
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "root-A",
      rootFolders: [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
    });
    mockVerifyByRootId({
      "root-A": errorResponse(404),
      "root-B": okFolderResponse("Verified B"),
    });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(mockedFetchWithAuth).toHaveBeenCalledTimes(2);
    });
    await settleAfter(20);
    expect(useDriveStore.getState().appRootFolder).toBeNull();
    expect(useDriveStore.getState().rootFolders).toEqual([]);
  });

  it("lets a root the user commits mid-init win over the in-flight remote root list", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: { id: "old-folder", name: "Old Folder", history: [] },
    });
    mockedGetAppConfig.mockImplementationOnce(() => deferredConfig());
    mockVerifyByRootId({
      "root-A": okFolderResponse("A"),
      "root-B": okFolderResponse("B"),
    });

    const { result } = renderHook(() => useDrive(true, "tok1"));
    await waitFor(() => {
      expect(mockedGetAppConfig).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.commitRootFolders([{ id: "root-B", name: "B" }]);
    });
    expect(useDriveStore.getState().appRootFolder).toBe("root-B");

    await settlePendingConfig({ rootFolderId: "root-A" });

    expect(useDriveStore.getState().appRootFolder).toBe("root-B");
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "root-B", name: "B" },
    ]);
    expect(useDriveStore.getState().currentFolderId).toBe("root-B");
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-B");
    expect(readStoredRoots()).toEqual([{ id: "root-B", name: "B" }]);
    expect(mockedFetchWithAuth).not.toHaveBeenCalled();
    expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === CLEAR_LOCAL_CACHE_CMD),
    ).toHaveLength(1);
  });

  it("keeps the root list and live nav on token rotation with an unchanged list", async () => {
    seedLocalRoots(
      [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
      "root-A",
    );
    const remoteList = {
      rootFolderId: "root-A",
      rootFolders: [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
    };
    mockedGetAppConfig.mockResolvedValue(remoteList);
    mockVerifyByRootId({
      "root-A": okFolderResponse("A"),
      "root-B": okFolderResponse("B"),
    });

    const { rerender } = renderHook(
      ({ token }: { token: string | null }) => useDrive(true, token),
      { initialProps: { token: "tok1" } },
    );
    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    });

    act(() => {
      useDriveStore.getState().setCurrentFolderId("folder-X");
    });

    act(() => {
      rerender({ token: "tok2" });
    });
    await waitFor(() => {
      expect(mockedGetAppConfig).toHaveBeenCalledTimes(2);
    });
    await settleAfter(50);

    expect(useDriveStore.getState().currentFolderId).toBe("folder-X");
    expect(useDriveStore.getState().rootFolders).toHaveLength(2);
    expect(mockedWipeFileRowsForUser).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
  });

  it("keeps the root list and live nav when a token-rotation verify returns 5xx", async () => {
    seedLocalRoots(
      [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
      "root-A",
    );
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "root-A",
      rootFolders: [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
    });
    mockVerifyByRootId({
      "root-A": okFolderResponse("A"),
      "root-B": okFolderResponse("B"),
    });

    const { rerender } = renderHook(
      ({ token }: { token: string | null }) => useDrive(true, token),
      { initialProps: { token: "tok1" } },
    );
    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    });

    act(() => {
      useDriveStore.getState().setCurrentFolderId("folder-X");
    });

    mockedFetchWithAuth.mockResolvedValue(errorResponse(503));
    act(() => {
      rerender({ token: "tok2" });
    });
    await waitFor(() => {
      expect(mockedCaptureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining(
            "reverify-transient: keeping previous roots",
          ) as unknown as string,
        }),
      );
    });
    await settleAfter(50);

    expect(useDriveStore.getState().rootFolders).toHaveLength(2);
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    expect(useDriveStore.getState().currentFolderId).toBe("folder-X");
  });

  it("invalidates the account cache, persists the list, and lands virtual when the remote list grows", async () => {
    seedLocalRoots([{ id: "root-A", name: "A" }], "root-A");
    localStorage.setItem(USER_EMAIL_KEY, "a@x");
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: {
        id: "old-folder",
        name: "Old Folder",
        history: [{ id: "root-A", name: MY_DRIVE_TAB }],
      },
    });
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "root-A",
      rootFolders: [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
    });
    mockVerifyByRootId({
      "root-A": okFolderResponse("A real"),
      "root-B": okFolderResponse("B real"),
    });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    });
    expect(mockedWipeFileRowsForUser).toHaveBeenCalledTimes(1);
    expect(mockedWipeFileRowsForUser).toHaveBeenCalledWith("a@x");
    expect(mockedInvoke).toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "root-A", name: "A real" },
      { id: "root-B", name: "B real" },
    ]);
    expect(useDriveStore.getState().currentFolderName).toBe(VIRTUAL_ROOT_NAME);
    expect(useDriveStore.getState().folderHistory).toEqual([]);
    expect(readStoredRoots()).toEqual([
      { id: "root-A", name: "A real" },
      { id: "root-B", name: "B real" },
    ]);
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-A");
  });

  it("restores a saved virtual-root position for a multi-root config", async () => {
    seedLocalRoots(
      [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
      "root-A",
    );
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: {
        id: VIRTUAL_ROOT_ID,
        name: "Stale Virtual Name",
        history: [{ id: "root-A", name: "A" }],
      },
    });
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "root-A",
      rootFolders: [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
    });
    mockVerifyByRootId({
      "root-A": okFolderResponse("A"),
      "root-B": okFolderResponse("B"),
    });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    });
    expect(useDriveStore.getState().currentFolderName).toBe(VIRTUAL_ROOT_NAME);
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: "root-A", name: "A" },
    ]);
  });

  it("falls back to the primary root when a saved virtual-root position meets a single-root config", async () => {
    seedLocalRoots([{ id: "root-A", name: "A" }], "root-A");
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: { id: VIRTUAL_ROOT_ID, name: VIRTUAL_ROOT_NAME, history: [] },
    });
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "root-A",
      rootFolders: [{ id: "root-A", name: "A" }],
    });
    mockVerifyByRootId({ "root-A": okFolderResponse("A") });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe("root-A");
    });
    expect(useDriveStore.getState().currentFolderName).toBe(MY_DRIVE_TAB);
    expect(useDriveStore.getState().folderHistory).toEqual([]);
  });

  it("keeps the saved name when restoring a non-primary configured root", async () => {
    seedLocalRoots(
      [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
      "root-A",
    );
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: {
        id: "root-B",
        name: "Bee's Folder",
        history: [{ id: "root-A", name: "A" }],
      },
    });
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "root-A",
      rootFolders: [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
    });
    mockVerifyByRootId({
      "root-A": okFolderResponse("A"),
      "root-B": okFolderResponse("B"),
    });

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe("root-B");
    });
    expect(useDriveStore.getState().currentFolderName).toBe("Bee's Folder");
  });
});

describe("useDrive initApp transient verify failures keep stored roots (B v2)", () => {
  const settleAfter = async (ms: number) => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };

  const expectNoWipe = () => {
    expect(mockedWipeFileRowsForUser).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
  };

  it("keeps the stored single legacy root when the first-init verify throws (network)", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    localStorage.setItem(USER_EMAIL_KEY, "a@x");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-A" });
    mockedFetchWithAuth.mockRejectedValue(new Error("network down"));
    const clearSpy = vi.spyOn(db.files, "clear");

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    });
    await settleAfter(20);
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "root-A", name: MY_DRIVE_TAB },
    ]);
    expect(useDriveStore.getState().currentFolderId).toBe("root-A");
    expect(useDriveStore.getState().currentFolderName).toBe(MY_DRIVE_TAB);
    expect(clearSpy).not.toHaveBeenCalled();
    expectNoWipe();
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "verify-roots-transient",
        ) as unknown as string,
      }),
    );
  });

  it("keeps the stored multi-root list when offline at first init", async () => {
    seedLocalRoots(
      [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
      "root-A",
    );
    mockedGetAppConfig.mockResolvedValue(null);
    mockedFetchWithAuth.mockRejectedValue(new Error("offline"));
    const clearSpy = vi.spyOn(db.files, "clear");

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    });
    await settleAfter(20);
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "root-A", name: "A" },
      { id: "root-B", name: "B" },
    ]);
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    expect(useDriveStore.getState().currentFolderName).toBe(VIRTUAL_ROOT_NAME);
    expect(clearSpy).not.toHaveBeenCalled();
    expectNoWipe();
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "verify-roots-transient",
        ) as unknown as string,
      }),
    );
  });

  it("keeps the stored single root when the first-init verify returns 500", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    localStorage.setItem(USER_EMAIL_KEY, "a@x");
    mockedGetAppConfig.mockResolvedValue({ rootFolderId: "root-A" });
    mockedFetchWithAuth.mockResolvedValue(errorResponse(500));
    const clearSpy = vi.spyOn(db.files, "clear");

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    });
    await settleAfter(20);
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "root-A", name: MY_DRIVE_TAB },
    ]);
    expect(useDriveStore.getState().currentFolderId).toBe("root-A");
    expect(clearSpy).not.toHaveBeenCalled();
    expectNoWipe();
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "verify-roots-transient",
        ) as unknown as string,
      }),
    );
  });

  it("does not adopt, persist or wipe a grown remote list when its verify fails transiently", async () => {
    localStorage.setItem(ROOT_FOLDER_KEY, "root-A");
    localStorage.setItem(USER_EMAIL_KEY, "a@x");
    mockedGetAppConfig.mockResolvedValue({
      rootFolderId: "root-A",
      rootFolders: [
        { id: "root-A", name: "A" },
        { id: "root-B", name: "B" },
      ],
    });
    mockedFetchWithAuth.mockRejectedValue(new Error("timeout"));
    const clearSpy = vi.spyOn(db.files, "clear");

    renderHook(() => useDrive(true, "tok1"));

    await waitFor(() => {
      expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    });
    await settleAfter(20);
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "root-A", name: MY_DRIVE_TAB },
    ]);
    expect(useDriveStore.getState().currentFolderId).toBe("root-A");
    expect(useDriveStore.getState().currentFolderName).toBe(MY_DRIVE_TAB);
    expect(localStorage.getItem(ROOT_FOLDERS_KEY)).toBeNull();
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-A");
    expect(clearSpy).not.toHaveBeenCalled();
    expectNoWipe();
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "verify-roots-transient",
        ) as unknown as string,
      }),
    );
  });
});
