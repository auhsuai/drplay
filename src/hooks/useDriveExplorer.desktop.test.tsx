// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveExplorer } from "./useDriveExplorer";

// Task 14 regression guard: DESKTOP keeps the historical 50-item page slice
// and multi-page totals (the pagination UX is desktop-only by contract).
vi.mock("../utils/platform", () => ({ IS_MOBILE: false }));

const FOLDER_ID = "desktop-folder";

function seedFolder(count: number) {
  return db.files.bulkAdd(
    Array.from({ length: count }, (_, i) => ({
      id: `d-${String(i)}`,
      name: `track-${String(i)}.mp3`,
      mimeType: "audio/mpeg",
      parentId: FOLDER_ID,
      size: 1000,
      modifiedTime: "2024-01-01T00:00:00.000Z",
      trashed: false,
      isFolder: false,
    })),
  );
}

describe("useDriveExplorer — desktop: pagination unchanged", () => {
  beforeEach(async () => {
    await db.files.clear();
  });

  afterEach(async () => {
    await db.files.clear();
  });

  it("still slices 120 items into pages of 50", async () => {
    await seedFolder(120);

    const { result } = renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", null, () => {}),
    );

    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(120);
    });

    expect(result.current.currentItems).toHaveLength(50);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.currentPage).toBe(1);
  });
});
