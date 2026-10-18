// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { wipeFileRowsForUser } from "../db/fileRows";
import { saveAppConfig } from "../utils/driveApi";
import { getValidToken } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { captureError } from "../utils/errorLog";
import { useDriveStore } from "../store/driveStore";
import {
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  DB_NAV_STATE_KEY,
  FOLDER_HISTORY_KEY,
  ROOT_FOLDER_KEY,
  ROOT_FOLDERS_KEY,
  ROOT_FOLDERS_UPDATED_KEY,
  USER_EMAIL_KEY,
} from "../utils/storageKeys";
import {
  MY_DRIVE_TAB,
  ROOT_FOLDER_ID,
  VIRTUAL_ROOT_ID,
  VIRTUAL_ROOT_NAME,
} from "../utils/driveConstants";
import type { RootFolder } from "../utils/rootFolders";
import { useDriveRootSelector } from "./useDriveRootSelector";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(),
}));

vi.mock("../utils/driveApi", () => ({
  saveAppConfig: vi.fn(),
}));

vi.mock("../utils/cache", () => ({
  CLEAR_LOCAL_CACHE_CMD: "clear_local_cache",
}));

vi.mock("../db/fileRows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/fileRows")>();
  return {
    ...actual,
    wipeFileRowsForUser: vi.fn(actual.wipeFileRowsForUser),
  };
});

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedGetValidToken = vi.mocked(getValidToken);
const mockedSaveAppConfig = vi.mocked(saveAppConfig);
const mockedWipeFileRowsForUser = vi.mocked(wipeFileRowsForUser);
const mockedCaptureError = vi.mocked(captureError);

const makeRoots = (ids: string[]): RootFolder[] =>
  ids.map((id) => ({ id, name: `Root ${id}` }));

const readStoredRoots = (): unknown => {
  const raw = localStorage.getItem(ROOT_FOLDERS_KEY);
  return raw === null ? null : JSON.parse(raw);
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
  mockedSaveAppConfig.mockResolvedValue(true);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await db.files.clear();
  await db.syncState.clear();
});

describe("commitRootFolders - single root", () => {
  it("writes both localStorage keys, lands on the root, and saves one config", async () => {
    const { result } = renderHook(() => useDriveRootSelector());

    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.commitRootFolders([
        { id: "root-A", name: "Music" },
      ]);
    });

    expect(committed).toBe(true);
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-A");
    expect(readStoredRoots()).toEqual([{ id: "root-A", name: "Music" }]);

    const state = useDriveStore.getState();
    expect(state.rootFolders).toEqual([{ id: "root-A", name: "Music" }]);
    expect(state.appRootFolder).toBe("root-A");
    expect(state.currentFolderId).toBe("root-A");
    expect(state.currentFolderName).toBe(MY_DRIVE_TAB);
    expect(state.folderHistory).toEqual([]);

    expect(mockedSaveAppConfig).toHaveBeenCalledTimes(1);
    const savedConfig: Record<string, unknown> = {
      rootFolderId: "root-A",
      rootFolderName: "Music",
      rootFolders: [{ id: "root-A", name: "Music" }],
      updatedAt: expect.any(Number),
    };
    expect(mockedSaveAppConfig).toHaveBeenCalledWith("tok", savedConfig);
  });
});

describe("commitRootFolders - multiple roots", () => {
  it("lands on the virtual root, keeps the primary in the legacy key, and saves one config", async () => {
    const { result } = renderHook(() => useDriveRootSelector());
    const roots = makeRoots(["root-A", "root-B"]);

    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.commitRootFolders(roots);
    });

    expect(committed).toBe(true);
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-A");
    expect(readStoredRoots()).toEqual(roots);

    const state = useDriveStore.getState();
    expect(state.rootFolders).toEqual(roots);
    expect(state.appRootFolder).toBe("root-A");
    expect(state.currentFolderId).toBe(VIRTUAL_ROOT_ID);
    expect(state.currentFolderName).toBe(VIRTUAL_ROOT_NAME);
    expect(state.folderHistory).toEqual([]);

    expect(mockedSaveAppConfig).toHaveBeenCalledTimes(1);
    const savedConfig: Record<string, unknown> = {
      rootFolderId: "root-A",
      rootFolderName: "Root root-A",
      rootFolders: roots,
      updatedAt: expect.any(Number),
    };
    expect(mockedSaveAppConfig).toHaveBeenCalledWith("tok", savedConfig);
  });

  it("accepts exactly 5 roots", async () => {
    const { result } = renderHook(() => useDriveRootSelector());
    const roots = makeRoots(["r1", "r2", "r3", "r4", "r5"]);

    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.commitRootFolders(roots);
    });

    expect(committed).toBe(true);
    expect(useDriveStore.getState().rootFolders).toEqual(roots);
    expect(mockedSaveAppConfig).toHaveBeenCalledTimes(1);
  });
});

describe("commitRootFolders - invalid input", () => {
  beforeEach(() => {
    localStorage.setItem(ROOT_FOLDER_KEY, "keep-me");
    localStorage.setItem(ROOT_FOLDERS_KEY, "keep-list");
    useDriveStore.setState({
      appRootFolder: "keep-me",
      rootFolders: [{ id: "keep-me", name: "Keep" }],
      currentFolderId: "keep-me",
      currentFolderName: "Keep",
      folderHistory: [{ id: "keep-me", name: "Keep" }],
    });
  });

  it.each([
    ["6 roots", makeRoots(["r1", "r2", "r3", "r4", "r5", "r6"])],
    [
      "duplicate ids",
      [
        { id: "dup", name: "One" },
        { id: "dup", name: "Two" },
      ],
    ],
    ["a blank id", [{ id: "", name: "Nobody" }]],
  ])(
    "rejects %s without touching store or localStorage",
    async (_label, roots) => {
      const { result } = renderHook(() => useDriveRootSelector());

      let committed: boolean | undefined;
      await act(async () => {
        committed = await result.current.commitRootFolders(roots);
      });

      expect(committed).toBe(false);
      expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("keep-me");
      expect(localStorage.getItem(ROOT_FOLDERS_KEY)).toBe("keep-list");
      expect(useDriveStore.getState().rootFolders).toEqual([
        { id: "keep-me", name: "Keep" },
      ]);
      expect(useDriveStore.getState().appRootFolder).toBe("keep-me");
      expect(useDriveStore.getState().currentFolderId).toBe("keep-me");
      expect(useDriveStore.getState().currentFolderName).toBe("Keep");
      expect(useDriveStore.getState().folderHistory).toEqual([
        { id: "keep-me", name: "Keep" },
      ]);
      expect(mockedSaveAppConfig).not.toHaveBeenCalled();
      expect(mockedCaptureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining(
            "commit-roots-invalid",
          ) as unknown as string,
        }),
      );
    },
  );
});

describe("commitRootFolders - cloud save failures never roll back the session", () => {
  it("keeps the applied state when saveAppConfig resolves false", async () => {
    mockedSaveAppConfig.mockResolvedValue(false);
    const { result } = renderHook(() => useDriveRootSelector());

    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.commitRootFolders([
        { id: "root-A", name: "Music" },
      ]);
    });

    expect(committed).toBe(true);
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-A");
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "save-config-unsaved",
        ) as unknown as string,
      }),
    );
  });

  it("swallows a thrown saveAppConfig and keeps the applied state", async () => {
    mockedSaveAppConfig.mockRejectedValue(new Error("upload boom"));
    const { result } = renderHook(() => useDriveRootSelector());

    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.commitRootFolders([
        { id: "root-A", name: "Music" },
      ]);
    });

    expect(committed).toBe(true);
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "root-A", name: "Music" },
    ]);
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-A");
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining(
          "save-config-failed",
        ) as unknown as string,
      }),
    );
  });
});

describe("commitRootFolders - account-scoped cache invalidation", () => {
  it("uses the store-wide clear while the owner is still the sentinel", async () => {
    const clearSpy = vi.spyOn(db.files, "clear");
    const { result } = renderHook(() => useDriveRootSelector());

    await act(async () => {
      await result.current.commitRootFolders([{ id: "root-A", name: "Music" }]);
    });

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(mockedWipeFileRowsForUser).not.toHaveBeenCalled();
    expect(mockedInvoke).toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
  });

  it("wipes only the current account's rows for a real owner", async () => {
    localStorage.setItem(USER_EMAIL_KEY, "a@x");
    const clearSpy = vi.spyOn(db.files, "clear");
    const { result } = renderHook(() => useDriveRootSelector());

    await act(async () => {
      await result.current.commitRootFolders([{ id: "root-A", name: "Music" }]);
    });

    expect(mockedWipeFileRowsForUser).toHaveBeenCalledTimes(1);
    expect(mockedWipeFileRowsForUser).toHaveBeenCalledWith("a@x");
    expect(clearSpy).toHaveBeenCalledTimes(0);
    expect(mockedInvoke).toHaveBeenCalledWith(CLEAR_LOCAL_CACHE_CMD);
  });
});

describe("commitRootFolders - local version marker & nav snapshot invalidation", () => {
  it("writes the version marker and reuses it as saveAppConfig.updatedAt", async () => {
    const { result } = renderHook(() => useDriveRootSelector());

    await act(async () => {
      await result.current.commitRootFolders([{ id: "root-A", name: "Music" }]);
    });

    const markerRaw = localStorage.getItem(ROOT_FOLDERS_UPDATED_KEY);
    expect(markerRaw).not.toBeNull();
    const marker = Number(markerRaw);
    expect(Number.isFinite(marker)).toBe(true);

    expect(mockedSaveAppConfig).toHaveBeenCalledTimes(1);
    const savedConfig = mockedSaveAppConfig.mock.calls[0]?.[1] as
      Record<string, unknown> | undefined;
    expect(savedConfig?.updatedAt).toBe(marker);
  });

  it("deletes the persisted nav snapshot (Dexie + legacy keys) on commit", async () => {
    await db.syncState.put({
      key: DB_NAV_STATE_KEY,
      value: { id: "old-folder", name: "Old", history: [] },
    });
    localStorage.setItem(CURRENT_FOLDER_ID_KEY, "old-folder");
    localStorage.setItem(CURRENT_FOLDER_NAME_KEY, "Old");
    localStorage.setItem(
      FOLDER_HISTORY_KEY,
      JSON.stringify([{ id: "old-folder", name: "Old" }]),
    );

    const { result } = renderHook(() => useDriveRootSelector());
    await act(async () => {
      await result.current.commitRootFolders([{ id: "root-A", name: "Music" }]);
    });

    expect(await db.syncState.get(DB_NAV_STATE_KEY)).toBeUndefined();
    expect(localStorage.getItem(CURRENT_FOLDER_ID_KEY)).toBeNull();
    expect(localStorage.getItem(CURRENT_FOLDER_NAME_KEY)).toBeNull();
    expect(localStorage.getItem(FOLDER_HISTORY_KEY)).toBeNull();
  });

  it("still commits when the nav-snapshot delete fails", async () => {
    vi.spyOn(db.syncState, "delete").mockRejectedValue(new Error("dexie boom"));
    const { result } = renderHook(() => useDriveRootSelector());

    let committed: boolean | undefined;
    await act(async () => {
      committed = await result.current.commitRootFolders([
        { id: "root-A", name: "Music" },
      ]);
    });

    expect(committed).toBe(true);
    expect(useDriveStore.getState().appRootFolder).toBe("root-A");
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-A");
    expect(mockedSaveAppConfig).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining(
          "commit-nav-state-clear-failed",
        ) as unknown as string,
      }),
    );
  });
});

describe("handleSelectRootFolder - legacy single-root wrapper", () => {
  it("commits exactly one root named My Drive and saves that payload", async () => {
    const { result } = renderHook(() => useDriveRootSelector());

    await act(async () => {
      await result.current.handleSelectRootFolder("root-Z");
    });

    const state = useDriveStore.getState();
    expect(state.rootFolders).toEqual([{ id: "root-Z", name: MY_DRIVE_TAB }]);
    expect(state.appRootFolder).toBe("root-Z");
    expect(state.currentFolderId).toBe("root-Z");
    expect(state.currentFolderName).toBe(MY_DRIVE_TAB);
    expect(localStorage.getItem(ROOT_FOLDER_KEY)).toBe("root-Z");
    expect(readStoredRoots()).toEqual([{ id: "root-Z", name: MY_DRIVE_TAB }]);
    expect(mockedSaveAppConfig).toHaveBeenCalledTimes(1);
    const savedConfig: Record<string, unknown> = {
      rootFolderId: "root-Z",
      rootFolderName: MY_DRIVE_TAB,
      rootFolders: [{ id: "root-Z", name: MY_DRIVE_TAB }],
      updatedAt: expect.any(Number),
    };
    expect(mockedSaveAppConfig).toHaveBeenCalledWith("tok", savedConfig);
  });
});
