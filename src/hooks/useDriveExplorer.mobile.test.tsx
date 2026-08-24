// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveExplorer } from "./useDriveExplorer";

// Task 14: on mobile every list scrolls virtually with NO pagination, so the
// explorer must NOT slice the item list (ITEMS_PER_PAGE is derived at module
// load from this flag — a static mock is the only way to exercise the branch).
vi.mock("../utils/platform", () => ({ IS_MOBILE: true }));

const FOLDER_ID = "mobile-folder";

function seedFolder(count: number) {
  return db.files.bulkAdd(
    Array.from({ length: count }, (_, i) => ({
      id: `f-${String(i)}`,
      name: `track-${String(i)}.mp3`,
      mimeType: "audio/mpeg",
      parentId: FOLDER_ID,
      size: 1000,
      modifiedTime: "2024-01-01T00:00:00.000Z",
      trashed: false,
      isFolder: false,
      userEmail: "default", // compound PK part (schema v10)
    })),
  );
}

describe("useDriveExplorer — mobile: no pagination slicing", () => {
  beforeEach(async () => {
    await db.files.clear();
  });

  afterEach(async () => {
    await db.files.clear();
  });

  it("serves the FULL list as one page (virtual scroll owns rendering)", async () => {
    await seedFolder(120);

    const { result } = renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", null, () => {}),
    );

    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(120);
    });

    // 120 > the desktop 50/page threshold: mobile must NOT slice.
    expect(result.current.currentItems).toHaveLength(120);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.currentPage).toBe(1);
  });
});
