// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { DriveItem } from "../types";
import { sortDriveItems, useDriveListing } from "./useDriveListing";
import { db } from "../db/db";
import { useDriveStore } from "../store/driveStore";
import { VIRTUAL_ROOT_ID, VIRTUAL_ROOT_NAME } from "../utils/driveConstants";

// Contract for the extracted pure sort (useDriveListing.ts). Behavior is
// frozen from the pre-extraction switch: cachedTitle (metadata title) wins
// over the filename-derived title for the name/name desc/default cases, while
// the modifiedTime/size tie-breaks use the RAW title (NOT cachedTitle) — this
// asymmetry is load-bearing and must not be "fixed" silently.

const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function makeItem(
  id: string,
  title: string,
  opts: { isFolder?: boolean; size?: number; modifiedTime?: string } = {},
): DriveItem {
  return {
    id,
    title,
    isFolder: opts.isFolder ?? false,
    size: opts.size,
    modifiedTime: opts.modifiedTime,
  };
}

const noCache = (): string | undefined => undefined;

describe("sortDriveItems", () => {
  it("sorts by name using the cached metadata title when present, else the raw title", () => {
    const cache: Record<string, string> = { "id-b": "Alpha" };
    const items = [makeItem("id-a", "Zed.mp3"), makeItem("id-b", "Beta.mp3")];
    const sorted = sortDriveItems(items, "name", COLLATOR, (id) => cache[id]);
    expect(sorted.map((i) => i.id)).toEqual(["id-b", "id-a"]);
  });

  it("sorts by name desc", () => {
    const items = [makeItem("id-a", "Alpha.mp3"), makeItem("id-b", "Zed.mp3")];
    const sorted = sortDriveItems(items, "name desc", COLLATOR, noCache);
    expect(sorted.map((i) => i.id)).toEqual(["id-b", "id-a"]);
  });

  it("sorts by modifiedTime ascending, raw-title tie-break (not cachedTitle)", () => {
    const cache: Record<string, string> = {
      "id-new": "Aaa",
      "id-old": "Zzz",
    };
    const items = [
      makeItem("id-new", "Zed.mp3", {
        modifiedTime: "2025-01-01T00:00:00.000Z",
      }),
      makeItem("id-old", "Alpha.mp3", {
        modifiedTime: "2024-01-01T00:00:00.000Z",
      }),
    ];
    const sorted = sortDriveItems(
      items,
      "modifiedTime",
      COLLATOR,
      (id) => cache[id],
    );
    // oldest first; the equal-time tie-break would also use raw title
    expect(sorted.map((i) => i.id)).toEqual(["id-old", "id-new"]);
  });

  it("sorts by modifiedTime desc", () => {
    const items = [
      makeItem("id-old", "Alpha.mp3", {
        modifiedTime: "2024-01-01T00:00:00.000Z",
      }),
      makeItem("id-new", "Zed.mp3", {
        modifiedTime: "2025-01-01T00:00:00.000Z",
      }),
    ];
    const sorted = sortDriveItems(
      items,
      "modifiedTime desc",
      COLLATOR,
      noCache,
    );
    expect(sorted.map((i) => i.id)).toEqual(["id-new", "id-old"]);
  });

  it("sorts by size ascending, raw-title tie-break (not cachedTitle)", () => {
    const cache: Record<string, string> = {
      "id-big": "Aaa",
      "id-small": "Zzz",
    };
    const items = [
      makeItem("id-big", "Alpha.mp3", { size: 1000 }),
      makeItem("id-small", "Zed.mp3", { size: 10 }),
    ];
    const sorted = sortDriveItems(items, "size", COLLATOR, (id) => cache[id]);
    expect(sorted.map((i) => i.id)).toEqual(["id-small", "id-big"]);

    // equal sizes -> raw title decides, cachedTitle must NOT leak in
    const tie = sortDriveItems(
      [
        makeItem("id-big", "Zed.mp3", { size: 10 }),
        makeItem("id-small", "Alpha.mp3", { size: 10 }),
      ],
      "size",
      COLLATOR,
      (id) => cache[id],
    );
    expect(tie.map((i) => i.id)).toEqual(["id-small", "id-big"]);
  });

  it("sorts by size desc", () => {
    const items = [
      makeItem("id-small", "Alpha.mp3", { size: 10 }),
      makeItem("id-big", "Zed.mp3", { size: 1000 }),
    ];
    const sorted = sortDriveItems(items, "size desc", COLLATOR, noCache);
    expect(sorted.map((i) => i.id)).toEqual(["id-big", "id-small"]);
  });

  it("falls back to name sort for unknown/default options (name_natural included)", () => {
    const items = [
      makeItem("id-10", "Track10.mp3"),
      makeItem("id-2", "Track2.mp3"),
      makeItem("id-a", "Alpha.mp3"),
    ];
    for (const option of ["name_natural", "bogus-option"]) {
      const sorted = sortDriveItems(items, option, COLLATOR, noCache);
      // numeric collator: Track2 before Track10; Alpha first overall
      expect(sorted.map((i) => i.id)).toEqual(["id-a", "id-2", "id-10"]);
    }
  });

  it("keeps folders before files regardless of sort option", () => {
    const items = [
      makeItem("id-file", "A.mp3"),
      makeItem("id-folder", "Z Folder", { isFolder: true }),
    ];
    const sorted = sortDriveItems(items, "name desc", COLLATOR, noCache);
    expect(sorted.map((i) => i.id)).toEqual(["id-folder", "id-file"]);
  });

  it("does not mutate the input array", () => {
    const items = [makeItem("id-b", "Zed.mp3"), makeItem("id-a", "Alpha.mp3")];
    const snapshot = [...items];
    sortDriveItems(items, "name", COLLATOR, noCache);
    expect(items).toEqual(snapshot);
  });
});

describe("useDriveListing virtual root (multi-root)", () => {
  afterEach(async () => {
    await db.files.clear();
    useDriveStore.setState({ rootFolders: [] });
  });

  it("synthesizes one folder item per configured root and never reads sentinel-parent rows", async () => {
    useDriveStore.setState({
      rootFolders: [
        { id: "root-Z", name: "Zeta" },
        { id: "root-A", name: "Alpha" },
      ],
    });
    // A row whose parent is the virtual sentinel is proof the querier must
    // not run: querying parentId=VIRTUAL_ROOT_ID would surface it.
    await db.files.put({
      id: "leak-row",
      name: "must-not-appear.mp3",
      mimeType: "audio/mpeg",
      parentId: VIRTUAL_ROOT_ID,
      trashed: false,
      isFolder: false,
      userEmail: "default",
    });

    const { result } = renderHook(() =>
      useDriveListing({
        currentFolderId: VIRTUAL_ROOT_ID,
        currentFolderName: VIRTUAL_ROOT_NAME,
        sortOption: "name",
      }),
    );

    await waitFor(() => {
      expect(result.current.dbFiles).toEqual([]);
    });
    // Same sortDriveItems ordering as a normal listing: Alpha before Zeta.
    expect(result.current.items).toEqual([
      expect.objectContaining({
        id: "root-A",
        title: "Alpha",
        isFolder: true,
        parentId: VIRTUAL_ROOT_ID,
      }),
      expect.objectContaining({
        id: "root-Z",
        title: "Zeta",
        isFolder: true,
        parentId: VIRTUAL_ROOT_ID,
      }),
    ]);
    expect(result.current.items.every((item) => !item.trackInfo)).toBe(true);
    expect(result.current.items.some((item) => item.id === "leak-row")).toBe(
      false,
    );
  });

  it("applies the selected sort option to the root list", async () => {
    useDriveStore.setState({
      rootFolders: [
        { id: "root-Z", name: "Zeta" },
        { id: "root-A", name: "Alpha" },
      ],
    });

    const { result } = renderHook(() =>
      useDriveListing({
        currentFolderId: VIRTUAL_ROOT_ID,
        currentFolderName: VIRTUAL_ROOT_NAME,
        sortOption: "name desc",
      }),
    );

    await waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
    expect(result.current.items.map((item) => item.id)).toEqual([
      "root-Z",
      "root-A",
    ]);
  });

  it("keeps the plain Dexie listing for a real folder when one root is configured", async () => {
    useDriveStore.setState({
      rootFolders: [{ id: "root-A", name: "Root A" }],
    });
    await db.files.bulkPut([
      {
        id: "child-1",
        name: "child.mp3",
        mimeType: "audio/mpeg",
        parentId: "folder-child",
        trashed: false,
        isFolder: false,
        size: 10,
        userEmail: "default",
      },
      {
        id: "root-row",
        name: "root.mp3",
        mimeType: "audio/mpeg",
        parentId: "root-A",
        trashed: false,
        isFolder: false,
        size: 10,
        userEmail: "default",
      },
    ]);

    const { result } = renderHook(() =>
      useDriveListing({
        currentFolderId: "folder-child",
        currentFolderName: "Child",
        sortOption: "name",
      }),
    );

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });
    expect(result.current.items[0]).toEqual(
      expect.objectContaining({
        id: "child-1",
        title: "child",
        parentId: "folder-child",
      }),
    );
  });
});
