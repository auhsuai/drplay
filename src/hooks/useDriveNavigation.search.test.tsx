// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveStore } from "../store/driveStore";
import { useDriveNavigation } from "./useDriveNavigation";
import { MY_DRIVE_TAB, ROOT_FOLDER_ID } from "../utils/driveConstants";

vi.mock("../utils/history", () => ({
  recordFolderVisit: vi.fn(),
}));

const mockedRecordFolderVisit = vi.mocked(
  await import("../utils/history").then((m) => m.recordFolderVisit),
);

// Hierarchy under the Drive root:
//   root / Trữ Tình-Bolero (folder-C)
//     ├── Ngọc Lan (folder-A, the currently open sibling)
//     └── Lệ Quyên (folder-B, the folder clicked from global search)
const FOLDER_C = "folder-C";
const FOLDER_A = "folder-A";
const FOLDER_B = "folder-B";

function seedHierarchy() {
  return db.files.bulkPut([
    {
      id: FOLDER_C,
      name: "Trữ Tình-Bolero",
      mimeType: "application/vnd.google-apps.folder",
      parentId: ROOT_FOLDER_ID,
      trashed: false,
      isFolder: true,
      userEmail: "default",
    },
    {
      id: FOLDER_A,
      name: "Ngọc Lan",
      mimeType: "application/vnd.google-apps.folder",
      parentId: FOLDER_C,
      trashed: false,
      isFolder: true,
      userEmail: "default",
    },
    {
      id: FOLDER_B,
      name: "Lệ Quyên",
      mimeType: "application/vnd.google-apps.folder",
      parentId: FOLDER_C,
      trashed: false,
      isFolder: true,
      userEmail: "default",
    },
  ]);
}

function openAt(
  folderId: string,
  folderName: string,
  history: { id: string; name: string }[],
) {
  act(() => {
    useDriveStore.setState({
      currentFolderId: folderId,
      currentFolderName: folderName,
      folderHistory: history,
    });
  });
}

describe("useDriveNavigation cross-branch folder open from search", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.files.clear();
    await seedHierarchy();
    mockedRecordFolderVisit.mockClear();
  });

  afterEach(async () => {
    await db.files.clear();
  });

  it("rebuilds the TRUE breadcrumb when the clicked search folder's parent differs from current (sibling Ngọc Lan -> Lệ Quyên)", async () => {
    // Sitting inside Ngọc Lan; its (stale) trail is [root, Trữ Tình-Bolero].
    openAt(FOLDER_A, "Ngọc Lan", [
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      { id: FOLDER_C, name: "Trữ Tình-Bolero" },
    ]);
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      // Search hit for Lệ Quyên carries its real parent (Trữ Tình-Bolero).
      result.current.handleOpenFolder(FOLDER_B, "Lệ Quyên", FOLDER_C);
    });

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(FOLDER_B);
    });
    // TRUE ancestry: [root, Trữ Tình-Bolero], current = Lệ Quyên.
    // The blind-append bug would leave [root, Trữ Tình-Bolero, Ngọc Lan].
    expect(useDriveStore.getState().currentFolderName).toBe("Lệ Quyên");
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      { id: FOLDER_C, name: "Trữ Tình-Bolero" },
    ]);
    expect(mockedRecordFolderVisit).toHaveBeenCalledWith(FOLDER_B, "Lệ Quyên");
  });

  it("keeps the plain append for a direct-child drill-down (parent == current)", () => {
    openAt(FOLDER_C, "Trữ Tình-Bolero", [
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
    ]);
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder(FOLDER_B, "Lệ Quyên", FOLDER_C);
    });

    expect(useDriveStore.getState().currentFolderId).toBe(FOLDER_B);
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      { id: FOLDER_C, name: "Trữ Tình-Bolero" },
    ]);
    expect(mockedRecordFolderVisit).toHaveBeenCalledWith(FOLDER_B, "Lệ Quyên");
  });

  it("falls back to the legacy append (no crash) when the true path cannot be rebuilt", async () => {
    // Mirror only knows Ngọc Lan + Lệ Quyên; the real parent
    // (Trữ Tình-Bolero) was never mirrored -> walk must throw internally and
    // degrade to the old append instead of crashing or blanking the trail.
    await db.files.clear();
    await db.files.bulkPut([
      {
        id: FOLDER_A,
        name: "Ngọc Lan",
        mimeType: "application/vnd.google-apps.folder",
        parentId: ROOT_FOLDER_ID,
        trashed: false,
        isFolder: true,
        userEmail: "default",
      },
      {
        id: FOLDER_B,
        name: "Lệ Quyên",
        mimeType: "application/vnd.google-apps.folder",
        parentId: FOLDER_C,
        trashed: false,
        isFolder: true,
        userEmail: "default",
      },
    ]);
    openAt(FOLDER_A, "Ngọc Lan", [{ id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB }]);
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder(FOLDER_B, "Lệ Quyên", FOLDER_C);
    });

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(FOLDER_B);
    });
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      { id: FOLDER_A, name: "Ngọc Lan" },
    ]);
    expect(mockedRecordFolderVisit).toHaveBeenCalledWith(FOLDER_B, "Lệ Quyên");
  });
  it("keeps the legacy append when no parent info is known (plain listing click)", () => {
    openAt(FOLDER_A, "Ngọc Lan", [
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      { id: FOLDER_C, name: "Trữ Tình-Bolero" },
    ]);
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder(FOLDER_B, "Lệ Quyên");
    });

    expect(useDriveStore.getState().currentFolderId).toBe(FOLDER_B);
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      { id: FOLDER_C, name: "Trữ Tình-Bolero" },
      { id: FOLDER_A, name: "Ngọc Lan" },
    ]);
    expect(mockedRecordFolderVisit).toHaveBeenCalledWith(FOLDER_B, "Lệ Quyên");
  });

  it("superseded cross-branch open không ghi đè navigation mới hơn", async () => {
    // Race v1: click Lệ Quyên (cross-branch, async đang bay) -> kịp click
    // Mỹ Tâm (cross-branch khác) -> async cũ complete SAU ghi đè nav mới.
    // Dexie mock trì hoãn resolve out-of-order: lần TRƯỚC resolve sau.
    const FOLDER_E = "folder-E";
    const FOLDER_D = "folder-D";
    await db.files.bulkPut([
      {
        id: FOLDER_E,
        name: "Nhạc Trẻ",
        mimeType: "application/vnd.google-apps.folder",
        parentId: ROOT_FOLDER_ID,
        trashed: false,
        isFolder: true,
        userEmail: "default",
      },
      {
        id: FOLDER_D,
        name: "Mỹ Tâm",
        mimeType: "application/vnd.google-apps.folder",
        parentId: FOLDER_E,
        trashed: false,
        isFolder: true,
        userEmail: "default",
      },
    ]);
    openAt(FOLDER_A, "Ngọc Lan", [
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      { id: FOLDER_C, name: "Trữ Tình-Bolero" },
    ]);
    const { result } = renderHook(() => useDriveNavigation());

    const origGet = db.files.get.bind(db.files);
    // Dexie Table.get returns PromiseExtended — the delay wrapper keeps the
    // exact signature via typeof cast so tsc stays clean.
    const spy = vi.spyOn(db.files, "get").mockImplementation((async (
      ...args: Parameters<typeof db.files.get>
    ) => {
      const key = args[0] as unknown as [string, string];
      const id = Array.isArray(key) ? key[1] : undefined;
      if (id === FOLDER_B) {
        await new Promise((r) => setTimeout(r, 60));
      }
      return origGet(...args);
    }) as typeof db.files.get);
    try {
      act(() => {
        result.current.handleOpenFolder(FOLDER_B, "Lệ Quyên", FOLDER_C);
      });
      act(() => {
        result.current.handleOpenFolder(FOLDER_D, "Mỹ Tâm", FOLDER_E);
      });

      await waitFor(
        () => {
          expect(useDriveStore.getState().currentFolderId).toBe(FOLDER_D);
        },
        { timeout: 2000 },
      );
      // Cho async cũ (Lệ Quyên, delay 60ms) đủ thời gian complete SAU:
      // trên v1 không guard nó sẽ ghi đè về folder-B tại đây -> FAIL;
      // trên v2 có guard nó bị discard -> vẫn folder-D -> PASS.
      await new Promise((r) => setTimeout(r, 200));
      expect(useDriveStore.getState().currentFolderId).toBe(FOLDER_D);
      expect(useDriveStore.getState().currentFolderName).toBe("Mỹ Tâm");
      expect(useDriveStore.getState().folderHistory).toEqual([
        { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
        { id: FOLDER_E, name: "Nhạc Trẻ" },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("Back trong lúc cross-branch async đang bay không bị ghi đè", async () => {
    // Race v3: click Lệ Quyên (cross-branch, async đang bay) -> kịp bấm Back
    // -> async cũ complete SAU ghi đè state của Back.
    // Đang ở Ngọc Lan với trail [root, Trữ Tình-Bolero] nên Back có hiệu lực
    // (pop về Trữ Tình-Bolero, history còn [root]).
    openAt(FOLDER_A, "Ngọc Lan", [
      { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      { id: FOLDER_C, name: "Trữ Tình-Bolero" },
    ]);
    const { result } = renderHook(() => useDriveNavigation());

    const origGet = db.files.get.bind(db.files);
    const spy = vi.spyOn(db.files, "get").mockImplementation((async (
      ...args: Parameters<typeof db.files.get>
    ) => {
      const key = args[0] as unknown as [string, string];
      const id = Array.isArray(key) ? key[1] : undefined;
      if (id === FOLDER_B) {
        await new Promise((r) => setTimeout(r, 60));
      }
      return origGet(...args);
    }) as typeof db.files.get);
    try {
      act(() => {
        result.current.handleOpenFolder(FOLDER_B, "Lệ Quyên", FOLDER_C);
      });
      // Back sync ngay trong window async đang bay (trước khi resolve 60ms).
      act(() => {
        result.current.handleBack();
      });

      // State ngay sau Back: về Trữ Tình-Bolero, history đã pop còn [root].
      expect(useDriveStore.getState().currentFolderId).toBe(FOLDER_C);
      expect(useDriveStore.getState().folderHistory).toEqual([
        { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      ]);

      // Cho async cũ (Lệ Quyên, delay 60ms) đủ thời gian complete SAU:
      // trên v2 không bump ở handleBack nó sẽ ghi đè về folder-B tại đây
      // -> FAIL; trên v3 có bump nó bị discard -> vẫn folder-C -> PASS.
      await new Promise((r) => setTimeout(r, 200));
      expect(useDriveStore.getState().currentFolderId).toBe(FOLDER_C);
      expect(useDriveStore.getState().currentFolderName).toBe(
        "Trữ Tình-Bolero",
      );
      expect(useDriveStore.getState().folderHistory).toEqual([
        { id: ROOT_FOLDER_ID, name: MY_DRIVE_TAB },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
