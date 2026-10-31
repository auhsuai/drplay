// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { db, type DriveFile } from "../db/db";
import { useDriveExplorer } from "./useDriveExplorer";
import { useDriveStore } from "../store/driveStore";
import { useAuthStore } from "../store/authStore";
import { resetSearchWorkerState } from "../search/search.worker";

// Selection + pagination reset scope (Phase A): the reset key must be
// content-based over EVERY input that changes which item ids the result set
// contains — folder, query, listing sort, search mode, configured roots,
// account and search sort. A stale selection surviving any of them would let a
// bulk delete/move address ids that are no longer on screen.

const ROOT_ID = "root";

function makeFile(id: string, name: string): DriveFile {
  return {
    id,
    name,
    mimeType: "audio/mpeg",
    parentId: ROOT_ID,
    trashed: false,
    isFolder: false,
    modifiedTime: "2024-01-01T00:00:00.000Z",
    size: 1000,
    userEmail: "default",
  };
}

async function seedFiles(count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) =>
    makeFile(`f${String(i)}`, `track-${String(i)}.mp3`),
  );
  await db.files.bulkPut(rows);
}

function renderExplorer() {
  return renderHook(
    ({ folderName }: { folderName: string }) =>
      useDriveExplorer(ROOT_ID, folderName, null, () => {}),
    { initialProps: { folderName: "My Drive" } },
  );
}

// Puts the hook in the "user has selected something on page 2" state every
// reset test starts from.
async function mountWithSelection() {
  await seedFiles(120); // -> 3 pages at ITEMS_PER_PAGE = 50
  const view = renderExplorer();
  await waitFor(() => {
    expect(view.result.current.filteredItems.length).toBe(120);
  });
  act(() => {
    view.result.current.setIsSelectionMode(true);
    view.result.current.setSelectedIds(new Set(["f0", "f1"]));
    view.result.current.setCurrentPage(2);
  });
  expect(view.result.current.currentPage).toBe(2);
  expect(view.result.current.selectedIds.size).toBe(2);
  return view;
}

describe("useDriveExplorer selection/pagination reset scope (Phase A)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.files.clear();
    await db.metadataCache.clear();
    resetSearchWorkerState();
    act(() => {
      useDriveStore.setState({
        rootFolders: [{ id: ROOT_ID, name: "My Drive" }],
      });
      useAuthStore.setState({ userProfile: null });
    });
  });

  afterEach(async () => {
    await db.files.clear();
    await db.metadataCache.clear();
    act(() => {
      useDriveStore.setState({ rootFolders: [] });
      useAuthStore.setState({ userProfile: null });
    });
  });

  it("search mode change clears selection + page, and KEEPS the mode preference", async () => {
    const view = await mountWithSelection();

    act(() => {
      view.result.current.setSearchMode("recursive");
    });

    expect(view.result.current.searchMode).toBe("recursive");
    expect(view.result.current.currentPage).toBe(1);
    expect(view.result.current.selectedIds.size).toBe(0);
    expect(view.result.current.isSelectionMode).toBe(false);
    view.unmount();
  });

  it("root folders change clears selection + page", async () => {
    const view = await mountWithSelection();

    act(() => {
      useDriveStore.setState({
        rootFolders: [
          { id: ROOT_ID, name: "My Drive" },
          { id: "second-root", name: "Second" },
        ],
      });
    });

    expect(view.result.current.currentPage).toBe(1);
    expect(view.result.current.selectedIds.size).toBe(0);
    expect(view.result.current.isSelectionMode).toBe(false);
    view.unmount();
  });

  it("account (auth store email) change clears selection + page", async () => {
    const view = await mountWithSelection();

    act(() => {
      useAuthStore.setState({
        userProfile: {
          name: "Other",
          email: "other@example.com",
          picture: "",
        },
      });
    });

    expect(view.result.current.currentPage).toBe(1);
    expect(view.result.current.selectedIds.size).toBe(0);
    expect(view.result.current.isSelectionMode).toBe(false);
    view.unmount();
  });

  it("search sort (field|dir) change clears selection + page, and KEEPS the sort pref", async () => {
    const view = await mountWithSelection();

    act(() => {
      view.result.current.setSearchSort({ field: "name", dir: "asc" });
    });

    expect(view.result.current.searchSort).toEqual({
      field: "name",
      dir: "asc",
    });
    expect(view.result.current.currentPage).toBe(1);
    expect(view.result.current.selectedIds.size).toBe(0);
    expect(view.result.current.isSelectionMode).toBe(false);
    view.unmount();
  });

  it("search query change clears selection + page", async () => {
    const view = await mountWithSelection();

    act(() => {
      view.result.current.setSearchQuery("track");
    });

    expect(view.result.current.currentPage).toBe(1);
    expect(view.result.current.selectedIds.size).toBe(0);
    expect(view.result.current.isSelectionMode).toBe(false);
    view.unmount();
  });

  it("an unrelated re-render (folder name prop only) does NOT reset selection/page", async () => {
    const view = await mountWithSelection();

    view.rerender({ folderName: "My Drive (renamed)" });

    expect(view.result.current.currentPage).toBe(2);
    expect(view.result.current.selectedIds.size).toBe(2);
    expect(view.result.current.isSelectionMode).toBe(true);
    view.unmount();
  });

  it("pagination alone keeps the selection (valid filtered ids survive page change)", async () => {
    const view = await mountWithSelection();

    act(() => {
      view.result.current.setCurrentPage(3);
    });

    expect(view.result.current.currentPage).toBe(3);
    expect(view.result.current.selectedIds.size).toBe(2);
    expect(view.result.current.isSelectionMode).toBe(true);
    view.unmount();
  });
});
