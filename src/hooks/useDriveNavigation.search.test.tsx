// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveStore } from "../store/driveStore";
import { useDriveNavigation } from "./useDriveNavigation";
import {
  MY_DRIVE_TAB,
  ROOT_FOLDER_ID,
  VIRTUAL_ROOT_ID,
  VIRTUAL_ROOT_NAME,
} from "../utils/driveConstants";
import { ROOT_FOLDER_KEY } from "../utils/storageKeys";

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

const ROOT_A = "multi-root-A";
const ROOT_B = "multi-root-B";
const NAV_B = "nav-B";
const NAV_C = "nav-C";
const NAV_SUB_B = "nav-sub-B";
const NAV_DEEP_B = "nav-deep-B";

function seedMultiRootHierarchy() {
  return db.files.bulkPut([
    {
      id: NAV_B,
      name: "B",
      mimeType: "application/vnd.google-apps.folder",
      parentId: ROOT_A,
      trashed: false,
      isFolder: true,
      userEmail: "default",
    },
    {
      id: NAV_C,
      name: "C",
      mimeType: "application/vnd.google-apps.folder",
      parentId: NAV_B,
      trashed: false,
      isFolder: true,
      userEmail: "default",
    },
    {
      id: NAV_SUB_B,
      name: "Sub B",
      mimeType: "application/vnd.google-apps.folder",
      parentId: ROOT_B,
      trashed: false,
      isFolder: true,
      userEmail: "default",
    },
    {
      id: NAV_DEEP_B,
      name: "Deep B",
      mimeType: "application/vnd.google-apps.folder",
      parentId: NAV_SUB_B,
      trashed: false,
      isFolder: true,
      userEmail: "default",
    },
  ]);
}

describe("useDriveNavigation virtual root (multi-root)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.files.clear();
    await seedMultiRootHierarchy();
    mockedRecordFolderVisit.mockClear();
    act(() => {
      useDriveStore.setState({
        rootFolders: [
          { id: ROOT_A, name: "Root A" },
          { id: ROOT_B, name: "Root B" },
        ],
        currentFolderId: VIRTUAL_ROOT_ID,
        currentFolderName: VIRTUAL_ROOT_NAME,
        folderHistory: [],
      });
    });
  });

  afterEach(async () => {
    await db.files.clear();
    act(() => {
      useDriveStore.setState({
        rootFolders: [],
        currentFolderId: ROOT_FOLDER_ID,
        currentFolderName: MY_DRIVE_TAB,
        folderHistory: [],
      });
    });
  });

  it("opening a root from the virtual root pushes the virtual root and Back returns to it", () => {
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder(ROOT_A, "Root A", VIRTUAL_ROOT_ID);
    });

    expect(useDriveStore.getState().currentFolderId).toBe(ROOT_A);
    expect(useDriveStore.getState().currentFolderName).toBe("Root A");
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: VIRTUAL_ROOT_ID, name: VIRTUAL_ROOT_NAME },
    ]);

    act(() => {
      result.current.handleBack();
    });

    expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    expect(useDriveStore.getState().currentFolderName).toBe(VIRTUAL_ROOT_NAME);
    expect(useDriveStore.getState().folderHistory).toEqual([]);
  });

  it("A/B/C navigation: Back walks A/B, A, virtual; breadcrumb click on virtual clears the trail", async () => {
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder(ROOT_A, "Root A", VIRTUAL_ROOT_ID);
    });
    act(() => {
      result.current.handleOpenFolder(NAV_C, "C", NAV_B);
    });

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(NAV_C);
    });
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: VIRTUAL_ROOT_ID, name: VIRTUAL_ROOT_NAME },
      { id: ROOT_A, name: "Root A" },
      { id: NAV_B, name: "B" },
    ]);

    act(() => {
      result.current.handleBack();
    });
    expect(useDriveStore.getState().currentFolderId).toBe(NAV_B);
    expect(useDriveStore.getState().currentFolderName).toBe("B");

    act(() => {
      result.current.handleBack();
    });
    expect(useDriveStore.getState().currentFolderId).toBe(ROOT_A);
    expect(useDriveStore.getState().currentFolderName).toBe("Root A");

    act(() => {
      result.current.handleBack();
    });
    expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    expect(useDriveStore.getState().currentFolderName).toBe(VIRTUAL_ROOT_NAME);

    // Rebuild the trail, then jump to the virtual breadcrumb item.
    act(() => {
      result.current.handleOpenFolder(ROOT_A, "Root A", VIRTUAL_ROOT_ID);
    });
    act(() => {
      result.current.handleOpenFolder(NAV_C, "C", NAV_B);
    });
    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(NAV_C);
    });

    act(() => {
      result.current.handleBreadcrumbClick(
        VIRTUAL_ROOT_ID,
        VIRTUAL_ROOT_NAME,
        0,
      );
    });
    expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);
    expect(useDriveStore.getState().currentFolderName).toBe(VIRTUAL_ROOT_NAME);
    expect(useDriveStore.getState().folderHistory).toEqual([]);
  });

  it("opens a second root from the virtual root and switches roots without a fake breadcrumb", async () => {
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder(ROOT_B, "Root B", VIRTUAL_ROOT_ID);
    });
    expect(useDriveStore.getState().currentFolderId).toBe(ROOT_B);
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: VIRTUAL_ROOT_ID, name: VIRTUAL_ROOT_NAME },
    ]);

    act(() => {
      result.current.handleBack();
    });
    expect(useDriveStore.getState().currentFolderId).toBe(VIRTUAL_ROOT_ID);

    // Search hit on another configured root (its real Drive parent is the
    // sentinel root, not the virtual node).
    act(() => {
      result.current.handleOpenFolder(ROOT_A, "Root A", ROOT_FOLDER_ID);
    });
    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(ROOT_A);
    });
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: VIRTUAL_ROOT_ID, name: VIRTUAL_ROOT_NAME },
    ]);
    expect(
      useDriveStore
        .getState()
        .folderHistory.some((entry) => entry.id === ROOT_B),
    ).toBe(false);
  });

  it("search jump into root B rebuilds [virtual, Root B, ...ancestors]", async () => {
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder(ROOT_A, "Root A", VIRTUAL_ROOT_ID);
    });

    act(() => {
      result.current.handleOpenFolder(NAV_DEEP_B, "Deep B", NAV_SUB_B);
    });

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(NAV_DEEP_B);
    });
    expect(useDriveStore.getState().currentFolderName).toBe("Deep B");
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: VIRTUAL_ROOT_ID, name: VIRTUAL_ROOT_NAME },
      { id: ROOT_B, name: "Root B" },
      { id: NAV_SUB_B, name: "Sub B" },
    ]);
    expect(mockedRecordFolderVisit).toHaveBeenCalledWith(NAV_DEEP_B, "Deep B");
  });

  it("search hit that IS a configured root rebuilds only [virtual]", async () => {
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder(ROOT_A, "Root A", VIRTUAL_ROOT_ID);
    });

    act(() => {
      result.current.handleOpenFolder(ROOT_B, "Root B", ROOT_FOLDER_ID);
    });

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe(ROOT_B);
    });
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: VIRTUAL_ROOT_ID, name: VIRTUAL_ROOT_NAME },
    ]);
  });
});

describe("useDriveNavigation single-root boundary (legacy behavior)", () => {
  const ROOT_S = "single-root-S";

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem(ROOT_FOLDER_KEY, ROOT_S);
    await db.files.clear();
    await db.files.put({
      id: "single-target",
      name: "Single Target",
      mimeType: "application/vnd.google-apps.folder",
      parentId: ROOT_S,
      trashed: false,
      isFolder: true,
      userEmail: "default",
    });
    act(() => {
      useDriveStore.setState({
        rootFolders: [{ id: ROOT_S, name: "Single Root" }],
        currentFolderId: VIRTUAL_ROOT_ID,
        currentFolderName: VIRTUAL_ROOT_NAME,
        folderHistory: [],
      });
    });
  });

  afterEach(async () => {
    await db.files.clear();
    act(() => {
      useDriveStore.setState({
        rootFolders: [],
        currentFolderId: ROOT_FOLDER_ID,
        currentFolderName: MY_DRIVE_TAB,
        folderHistory: [],
      });
    });
  });

  it("keeps the MY_DRIVE_TAB boundary name for the single configured root", async () => {
    const { result } = renderHook(() => useDriveNavigation());

    act(() => {
      result.current.handleOpenFolder("single-target", "Single Target", ROOT_S);
    });

    await waitFor(() => {
      expect(useDriveStore.getState().currentFolderId).toBe("single-target");
    });
    expect(useDriveStore.getState().folderHistory).toEqual([
      { id: ROOT_S, name: MY_DRIVE_TAB },
    ]);
  });
});
