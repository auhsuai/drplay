// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { db, type DriveFile } from "../db/db";
import { useDriveSearch } from "./useDriveSearch";
import { useDriveStore } from "../store/driveStore";
import { resetSearchWorkerState } from "../search/search.worker";

// Phase A hook-state tests (I2): mode/sort state machine + root wiring.
// Inline search path (jsdom has no Worker) with the REAL engine over
// fake-indexeddb tables; debounce + rebuild settle inside act (350ms > 150ms
// debounce + rebuild).

const ROOT_ID = "root";
const FOLDER_A = "folder-A";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function makeFile(
  id: string,
  name: string,
  opts: {
    isFolder?: boolean;
    mimeType?: string;
    parentId?: string;
    size?: number;
    modifiedTime?: string;
  } = {},
): DriveFile {
  return {
    id,
    name,
    mimeType: opts.mimeType ?? "audio/mpeg",
    parentId: opts.parentId ?? ROOT_ID,
    trashed: false,
    isFolder: opts.isFolder ?? false,
    size: opts.size,
    modifiedTime: opts.modifiedTime ?? "2024-01-01T00:00:00.000Z",
    userEmail: "default",
  };
}

async function settle(
  view: {
    result: {
      current: {
        searchQuery: string;
        setSearchQuery: (v: string) => void;
      };
    };
  },
  query: string,
) {
  act(() => {
    view.result.current.setSearchQuery(query);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
}

describe("useDriveSearch phase A (mode/sort/roots)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.files.clear();
    await db.metadataCache.clear();
    resetSearchWorkerState();
    act(() => {
      useDriveStore.setState({
        rootFolders: [{ id: FOLDER_A, name: "Root A" }],
      });
    });
  });

  afterEach(async () => {
    await db.files.clear();
    await db.metadataCache.clear();
    act(() => {
      useDriveStore.setState({ rootFolders: [] });
    });
  });

  it("H1. defaults: mode global, sort relevance desc; empty query -> []", () => {
    const view = renderHook(() => useDriveSearch(ROOT_ID));
    expect(view.result.current.searchMode).toBe("global");
    expect(view.result.current.searchSort).toEqual({
      field: "relevance",
      dir: "desc",
    });
    expect(view.result.current.globalSearchItems).toEqual([]);
    view.unmount();
  });

  it("H2. rootFolders flow from the store into the query context", async () => {
    await db.files.bulkPut([
      makeFile(FOLDER_A, "Root A", { isFolder: true, mimeType: FOLDER_MIME }),
      makeFile("a1", "Song inside.mp3", { parentId: FOLDER_A }),
      makeFile("far", "Song far.mp3", { parentId: "unrelated" }),
    ]);
    const view = renderHook(() => useDriveSearch(ROOT_ID));
    await settle(view, "song");
    const ids = view.result.current.globalSearchItems.map((i) => i.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("far");
    view.unmount();
  });

  it("H3. empty rootFolders -> globalSearchItems stays [] (fail closed)", async () => {
    await db.files.bulkPut([makeFile("a1", "Song inside.mp3")]);
    act(() => {
      useDriveStore.setState({ rootFolders: [] });
    });
    const view = renderHook(() => useDriveSearch(ROOT_ID));
    await settle(view, "song");
    expect(view.result.current.globalSearchItems).toEqual([]);
    view.unmount();
  });

  it("H4. recursive mode at a folder: subtree only, folder itself excluded", async () => {
    await db.files.bulkPut([
      makeFile(FOLDER_A, "Root A", { isFolder: true, mimeType: FOLDER_MIME }),
      makeFile("a1", "Song inside.mp3", { parentId: FOLDER_A }),
      makeFile("sub", "Sub folder", {
        isFolder: true,
        mimeType: FOLDER_MIME,
        parentId: FOLDER_A,
      }),
      makeFile("sub1", "Song deep.mp3", { parentId: "sub" }),
      makeFile("outside", "Song outside.mp3", { parentId: "root-elsewhere" }),
    ]);
    const view = renderHook(() => useDriveSearch(FOLDER_A));
    await settle(view, "song");
    act(() => {
      view.result.current.setSearchMode("recursive");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    const ids = view.result.current.globalSearchItems.map((i) => i.id);
    expect(ids).toContain("a1");
    expect(ids).toContain("sub1");
    // Current folder itself is a container, not a hit.
    expect(ids).not.toContain(FOLDER_A);
    expect(ids).not.toContain("outside");
    view.unmount();
  });

  it("H5. recursive at VIRTUAL_ROOT behaves like global (all roots scope)", async () => {
    await db.files.bulkPut([
      makeFile(FOLDER_A, "Root A", { isFolder: true, mimeType: FOLDER_MIME }),
      makeFile("a1", "Song inside.mp3", { parentId: FOLDER_A }),
    ]);
    const view = renderHook(() => useDriveSearch("__drplay_virtual_root__"));
    await settle(view, "song");
    act(() => {
      view.result.current.setSearchMode("recursive");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(view.result.current.globalSearchItems.map((i) => i.id)).toContain(
      "a1",
    );
    view.unmount();
  });

  it("H6. clearing the query KEEPS mode AND sort (reset only via user clicks); re-type reapplies both", async () => {
    // User feedback (2026-10-31, final): clear query (X or delete-all) only
    // clears the RESULTS — mode AND sort both survive; re-typing applies the
    // same mode + sort immediately. Neither resets on clear; both change ONLY
    // through explicit user clicks (icon toggle / header columns).
    await db.files.bulkPut([
      makeFile("a1", "Song.mp3", { parentId: FOLDER_A }),
    ]);
    const view = renderHook(() => useDriveSearch(ROOT_ID));
    await settle(view, "song");
    act(() => {
      view.result.current.setSearchMode("recursive");
      view.result.current.setSearchSort({ field: "name", dir: "desc" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(view.result.current.searchMode).toBe("recursive");
    expect(view.result.current.searchSort).toEqual({
      field: "name",
      dir: "desc",
    });

    // Non-empty query change: mode + sort KEPT.
    await settle(view, "song one");
    expect(view.result.current.searchMode).toBe("recursive");
    expect(view.result.current.searchSort).toEqual({
      field: "name",
      dir: "desc",
    });

    // Clear: mode AND sort KEPT (no reset at all).
    await settle(view, "");
    expect(view.result.current.searchMode).toBe("recursive");
    expect(view.result.current.searchSort).toEqual({
      field: "name",
      dir: "desc",
    });

    // Re-type: mode + sort STILL applied (the user-visible contract).
    await settle(view, "song");
    expect(view.result.current.searchMode).toBe("recursive");
    expect(view.result.current.searchSort).toEqual({
      field: "name",
      dir: "desc",
    });
    view.unmount();
  });

  it("H7. sort name asc orders files by name with folders first", async () => {
    // Folder name must match the query "song" too, so it can appear among
    // the hits and prove folders-first within name-asc ordering.
    await db.files.bulkPut([
      makeFile(FOLDER_A, "Song folder A", {
        isFolder: true,
        mimeType: FOLDER_MIME,
      }),
      makeFile("b", "song b.mp3", { parentId: FOLDER_A }),
      makeFile("c", "song c.mp3", { parentId: FOLDER_A }),
      makeFile("a", "song a.mp3", { parentId: FOLDER_A }),
    ]);
    const view = renderHook(() => useDriveSearch(ROOT_ID));
    await settle(view, "song");
    act(() => {
      view.result.current.setSearchSort({ field: "name", dir: "asc" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    const items = view.result.current.globalSearchItems;
    expect(items[0]?.id).toBe(FOLDER_A); // "Song folder A" — folder first
    expect(items.slice(1).map((i) => i.id)).toEqual(["a", "b", "c"]);
    view.unmount();
  });

  it("H8. mapping contract kept: folders carry no trackInfo; files carry parentName", async () => {
    await db.files.bulkPut([
      makeFile(FOLDER_A, "Song folder A", {
        isFolder: true,
        mimeType: FOLDER_MIME,
      }),
      makeFile("a1", "Song.mp3", { parentId: FOLDER_A }),
    ]);
    const view = renderHook(() => useDriveSearch(ROOT_ID));
    await settle(view, "song");
    const items = view.result.current.globalSearchItems;
    const folder = items.find((i) => i.id === FOLDER_A);
    const file = items.find((i) => i.id === "a1");
    expect(folder).toBeDefined();
    expect(folder?.trackInfo).toBeUndefined();
    expect(folder?.parentId).toBe(ROOT_ID);
    expect(file?.trackInfo?.parentName).toBe("Search Result");
    expect(file?.trackInfo?.originalName).toBe("Song.mp3");
    view.unmount();
  });
});
