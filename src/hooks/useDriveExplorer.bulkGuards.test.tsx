// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveExplorer } from "./useDriveExplorer";
import { useDriveStore } from "../store/driveStore";
import {
  deleteFile,
  moveFile,
  createFolder,
  driveFetch,
} from "../utils/driveApi";
import type { DriveFileItem } from "../utils/driveApi";
import { isUploading, getUploadState } from "../utils/uploadManager";
import { showErrorToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";

// Network layer mocked (mirrors useDriveExplorer.fetchOnDemand.test.tsx);
// uploadManager/driveApi/simpleToast mocked so bulk guards can be asserted
// in isolation. Dexie stays real (fake-indexeddb).
vi.mock("../utils/apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock("../utils/uploadManager", () => ({
  isUploading: vi.fn(),
  getUploadingIds: vi.fn(),
  getUploadState: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));
vi.mock("../utils/driveApi", () => ({
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
  createFolder: vi.fn(),
  driveFetch: vi.fn(),
}));
vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));
vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedIsUploading = vi.mocked(isUploading);
const mockedDeleteFile = vi.mocked(deleteFile);
const mockedMoveFile = vi.mocked(moveFile);
const mockedCreateFolder = vi.mocked(createFolder);
const mockedShowErrorToast = vi.mocked(showErrorToast);
const mockedGetUploadState = vi.mocked(getUploadState);
const mockedDriveFetch = vi.mocked(driveFetch);
const mockedCaptureError = vi.mocked(captureError);

const FOLDER_ID = "bulk-folder";
const TOKEN = "bulk-token";

beforeEach(async () => {
  await db.files.clear();
  useDriveStore.setState({ isLoadingTracks: false });
  mockedIsUploading.mockReset();
  mockedIsUploading.mockReturnValue(false);
  mockedGetUploadState.mockReset();
  mockedGetUploadState.mockReturnValue("none");
  mockedDeleteFile.mockReset();
  mockedDeleteFile.mockResolvedValue({
    id: "x",
    name: "x",
    mimeType: "audio/mpeg",
    parents: [FOLDER_ID],
  });
  mockedMoveFile.mockReset();
  mockedMoveFile.mockResolvedValue({
    id: "x",
    name: "x",
    mimeType: "audio/mpeg",
    parents: [FOLDER_ID],
  });
  mockedCreateFolder.mockReset();
  mockedCreateFolder.mockResolvedValue({
    id: "new-folder",
    name: "x",
    mimeType: "application/vnd.google-apps.folder",
    parents: [FOLDER_ID],
  });
  mockedShowErrorToast.mockReset();
  mockedCaptureError.mockReset();
  // fetchOnDemand runs on mount with the real token; a non-retryable 404 keeps
  // it out of the way (no retries, no real-time backoff).
  mockedDriveFetch.mockReset();
  mockedDriveFetch.mockResolvedValue({
    ok: false,
    status: 404,
  } as unknown as Response);
});

afterEach(async () => {
  await db.files.clear();
});

function setupSelection(ids: string[]) {
  const { result } = renderHook(() =>
    useDriveExplorer(FOLDER_ID, "Folder", TOKEN, () => {}),
  );
  act(() => {
    result.current.setSelectedIds(new Set(ids));
  });
  return result;
}

function uploadingId(id: string) {
  mockedIsUploading.mockImplementation((candidate: string) => candidate === id);
}

describe("useDriveExplorer bulk guard: upload-uploading items are never deleted", () => {
  it("skips uploading ids, deletes the rest, and toasts exactly once (mixed selection)", async () => {
    uploadingId("c");
    const result = setupSelection(["a", "b", "c"]);
    const onComplete = vi.fn();

    await act(async () => {
      await result.current.handleBulkDelete(onComplete);
    });

    expect(mockedDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockedDeleteFile).toHaveBeenCalledWith(TOKEN, "a");
    expect(mockedDeleteFile).toHaveBeenCalledWith(TOKEN, "b");
    expect(mockedDeleteFile).not.toHaveBeenCalledWith(TOKEN, "c");
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("returns early without deleting anything when every selected id is uploading", async () => {
    uploadingId("a");
    const result = setupSelection(["a"]);
    const onComplete = vi.fn();

    await act(async () => {
      await result.current.handleBulkDelete(onComplete);
    });

    expect(mockedDeleteFile).not.toHaveBeenCalled();
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(result.current.selectedIds.has("a")).toBe(true);
    expect(result.current.isBulkOperating).toBe(false);
  });

  it("keeps the old behavior (no toast, no filtering) when nothing is uploading", async () => {
    const result = setupSelection(["a", "b"]);

    try {
      await act(async () => {
        await result.current.handleBulkDelete(vi.fn());
      });
    } catch (e) {
      console.log("REAL ERROR:", (e as Error).stack);
      throw e;
    }

    expect(mockedDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockedShowErrorToast).not.toHaveBeenCalled();
  });
});

describe("useDriveExplorer bulk guard: upload-uploading items are never moved", () => {
  it("skips uploading ids, moves the rest, and toasts exactly once (mixed selection)", async () => {
    uploadingId("b");
    const result = setupSelection(["a", "b"]);

    await act(async () => {
      await result.current.handleBulkMove("dest-folder", vi.fn());
    });

    expect(mockedMoveFile).toHaveBeenCalledTimes(1);
    expect(mockedMoveFile).toHaveBeenCalledWith(
      TOKEN,
      "a",
      FOLDER_ID,
      "dest-folder",
    );
    expect(mockedMoveFile).not.toHaveBeenCalledWith(
      TOKEN,
      "b",
      FOLDER_ID,
      "dest-folder",
    );
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
  });

  it("returns early without moving anything when every selected id is uploading", async () => {
    uploadingId("a");
    const result = setupSelection(["a"]);

    await act(async () => {
      await result.current.handleBulkMove("dest-folder", vi.fn());
    });

    expect(mockedMoveFile).not.toHaveBeenCalled();
    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(result.current.selectedIds.has("a")).toBe(true);
  });

  it("keeps the old behavior (no toast, no filtering) when nothing is uploading", async () => {
    const result = setupSelection(["a", "b"]);

    await act(async () => {
      await result.current.handleBulkMove("dest-folder", vi.fn());
    });

    expect(mockedMoveFile).toHaveBeenCalledTimes(2);
    expect(mockedShowErrorToast).not.toHaveBeenCalled();
  });
});

describe("useDriveBulkOps logs bulk failures with source useDriveBulkOps", () => {
  it("logs a per-item bulk-delete failure with the bulk-ops source", async () => {
    mockedDeleteFile.mockRejectedValue(new Error("boom"));
    const result = setupSelection(["a"]);

    await act(async () => {
      await result.current.handleBulkDelete(vi.fn());
    });

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "useDriveBulkOps",
        message: "bulk-delete failed for item a: boom",
      }),
    );
  });

  it("logs a per-item bulk-move failure with the bulk-ops source", async () => {
    mockedMoveFile.mockRejectedValue(new Error("boom"));
    const result = setupSelection(["a"]);

    await act(async () => {
      await result.current.handleBulkMove("dest-folder", vi.fn());
    });

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "useDriveBulkOps",
        message: "bulk-move failed for item a: boom",
      }),
    );
  });

  it("logs a create-folder failure with the bulk-ops source", async () => {
    mockedCreateFolder.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", TOKEN, () => {}),
    );

    await act(async () => {
      await result.current.handleCreateFolder("New Folder", vi.fn());
    });

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "useDriveBulkOps",
        message: "create-folder failed: boom",
      }),
    );
  });
});

describe("useDriveBulkOps closes the confirm dialog immediately (action runs in background)", () => {
  function makeResolvedItem(id: string) {
    return { id, name: id, mimeType: "audio/mpeg", parents: [FOLDER_ID] };
  }

  it("bulk delete: calls onComplete BEFORE deleteFile resolves — the dialog closes while the network is still pending", async () => {
    const resolvers: Array<(value: DriveFileItem) => void> = [];
    mockedDeleteFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const result = setupSelection(["a", "b"]);
    const onComplete = vi.fn();

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleBulkDelete(onComplete);
    });

    // The dialog must be closable right away — deleteFile is STILL pending
    // here (old code fired onComplete only in finally, after the whole batch).
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(mockedDeleteFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      // Settle each in-flight delete one at a time, yielding a microtask so
      // the loop can issue the next call, until the whole batch is drained.
      for (let i = 0; i < 10 && resolvers.length > 0; i++) {
        resolvers.shift()?.(makeResolvedItem("x"));
        await Promise.resolve();
      }
      await pending;
    });

    // The background action still runs to completion after the dialog closed.
    expect(mockedDeleteFile).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.current.isBulkOperating).toBe(false);
    expect(result.current.selectedIds.size).toBe(0);
  });

  it("bulk delete: pre-flight failure (every id uploading) never calls onComplete — the dialog stays open", async () => {
    uploadingId("a");
    const result = setupSelection(["a"]);
    const onComplete = vi.fn();

    await act(async () => {
      await result.current.handleBulkDelete(onComplete);
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(mockedDeleteFile).not.toHaveBeenCalled();
    expect(result.current.selectedIds.has("a")).toBe(true);
  });

  it("bulk delete: onComplete fires early even when an item fails later — the error toast still surfaces", async () => {
    let rejectDelete!: (e: Error) => void;
    mockedDeleteFile.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectDelete = reject;
        }),
    );
    const result = setupSelection(["a"]);
    const onComplete = vi.fn();

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleBulkDelete(onComplete);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectDelete(new Error("boom"));
      await pending;
    });

    expect(mockedShowErrorToast).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("bulk move: calls onComplete BEFORE moveFile resolves — the screen closes while the network is still pending", async () => {
    const resolvers: Array<
      (value: DriveFileItem | { success: boolean }) => void
    > = [];
    mockedMoveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const result = setupSelection(["a"]);
    const onComplete = vi.fn();

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleBulkMove("dest-folder", onComplete);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (let i = 0; i < 10 && resolvers.length > 0; i++) {
        resolvers.shift()?.(makeResolvedItem("x"));
        await Promise.resolve();
      }
      await pending;
    });

    expect(mockedMoveFile).toHaveBeenCalledTimes(1);
    expect(mockedMoveFile).toHaveBeenCalledWith(
      TOKEN,
      "a",
      FOLDER_ID,
      "dest-folder",
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.current.isBulkOperating).toBe(false);
  });

  it("bulk move: pre-flight failure (every id uploading) never calls onComplete — the screen stays open", async () => {
    uploadingId("a");
    const result = setupSelection(["a"]);
    const onComplete = vi.fn();

    await act(async () => {
      await result.current.handleBulkMove("dest-folder", onComplete);
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(mockedMoveFile).not.toHaveBeenCalled();
  });
});

describe("useDriveExplorer: stale selection never survives a folder/search change", () => {
  function seedTwoFolders() {
    return db.files.bulkAdd([
      {
        id: "a1",
        name: "a-one.mp3",
        mimeType: "audio/mpeg",
        parentId: "folder-a",
        size: 1000,
        modifiedTime: "2024-01-01T00:00:00.000Z",
        trashed: false,
        isFolder: false,
        userEmail: "default", // compound PK part (schema v10)
      },
      {
        id: "b1",
        name: "b-one.mp3",
        mimeType: "audio/mpeg",
        parentId: "folder-b",
        size: 1000,
        modifiedTime: "2024-01-02T00:00:00.000Z",
        trashed: false,
        isFolder: false,
        userEmail: "default", // compound PK part (schema v10)
      },
    ]);
  }

  it("changing folders clears stale selection", async () => {
    await seedTwoFolders();
    let folderId = "folder-a";
    const { result, rerender } = renderHook(() =>
      useDriveExplorer(folderId, "Folder A", TOKEN, () => {}),
    );

    act(() => {
      result.current.setSelectedIds(new Set(["a1"]));
      result.current.setIsSelectionMode(true);
    });
    expect(result.current.selectedIds.has("a1")).toBe(true);
    expect(result.current.isSelectionMode).toBe(true);

    act(() => {
      folderId = "folder-b";
      rerender();
    });

    // Navigation really happened (folder B's listing rendered)…
    await waitFor(() => {
      expect(result.current.filteredItems.map((i) => i.id)).toEqual(["b1"]);
    });
    // …so the selection from folder A must NOT leak into folder B — bulk ops
    // run on raw selectedIds and would delete A's files while viewing B.
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.isSelectionMode).toBe(false);
  });

  it("typing a search query clears stale selection", async () => {
    await seedTwoFolders();
    const { result } = renderHook(() =>
      useDriveExplorer("folder-a", "Folder A", TOKEN, () => {}),
    );
    await waitFor(() => {
      expect(result.current.filteredItems.map((i) => i.id)).toEqual(["a1"]);
    });

    act(() => {
      result.current.setSelectedIds(new Set(["a1"]));
      result.current.setIsSelectionMode(true);
    });
    expect(result.current.selectedIds.size).toBe(1);

    act(() => {
      result.current.setSearchQuery("b-one");
    });

    await waitFor(() => {
      expect(result.current.selectedIds.size).toBe(0);
    });
    expect(result.current.isSelectionMode).toBe(false);
  });
});

describe("useDriveExplorer: currentPage clamps back into range when the list shrinks", () => {
  const FOLDER_CLAMP = "clamp-folder";

  it("clamps currentPage back into range when bulk delete empties the last page", async () => {
    await db.files.bulkAdd(
      Array.from({ length: 120 }, (_, i) => ({
        id: `d-${String(i)}`,
        name: `song-${String(i)}.mp3`,
        mimeType: "audio/mpeg",
        parentId: FOLDER_CLAMP,
        size: 1000,
        modifiedTime: "2024-01-01T00:00:00.000Z",
        trashed: false,
        isFolder: false,
        userEmail: "default", // compound PK part (schema v10)
      })),
    );

    const { result } = renderHook(() =>
      useDriveExplorer(FOLDER_CLAMP, "Folder", TOKEN, () => {}),
    );

    // Wait for the Dexie live listing to populate.
    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(120);
    });

    // User pages to the last page (items d-100..d-119).
    act(() => {
      result.current.setCurrentPage(3);
    });
    expect(result.current.currentPage).toBe(3);
    expect(result.current.currentItems).toHaveLength(20);

    // Bulk delete wipes every item on that page — the local Dexie mirror
    // loses the rows exactly as handleBulkDelete + refresh would leave them.
    await act(async () => {
      await db.files.bulkDelete(
        Array.from(
          { length: 20 },
          (_, i) => ["default", `d-${String(100 + i)}`] as [string, string],
        ),
      );
    });

    // The explorer must land back on a page that still has items instead of
    // showing an empty page until the user clicks pagination manually.
    await waitFor(() => {
      expect(result.current.currentPage).toBe(2);
    });
    expect(result.current.totalPages).toBe(2);
    expect(result.current.currentItems.length).toBeGreaterThan(0);
  });
});
