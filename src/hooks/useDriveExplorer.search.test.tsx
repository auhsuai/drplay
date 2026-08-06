// @vitest-environment jsdom
import "fake-indexeddb/auto";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { renderHook, act } from "@testing-library/react";
import { db, type DriveFile } from "../db/db";
import { useDriveExplorer } from "./useDriveExplorer";
import { metadataCache } from "../utils/metadata";

// Global search is a read-only Dexie filter — no network involved, so the
// hook is rendered with token=null to keep the on-demand fetch effect inert.

// Dexie's liveQuery first emit travels through real setTimeout(0) hops, and
// dexie-react-hooks keeps the source subscribed ~3s after unmount (observable
// cleanup delay), so a table write in another test of this file can land a
// triggerUpdate outside act. The update is a benign identical re-render —
// assertions below still gate on real search behavior — so only that specific
// React warning is silenced for this file; everything else passes through.
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("not wrapped in act")) {
      return;
    }
    originalConsoleError(...args);
  };
});
afterAll(() => {
  console.error = originalConsoleError;
});

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
  };
}

function renderSearch() {
  return renderHook(() =>
    useDriveExplorer(ROOT_ID, "My Drive", null, () => {}),
  );
}

// Search results are debounced (DEBOUNCE_DELAY_MS = 150ms real timers).
// Sleeping inside act lets the debounce timer + Dexie query land inside act,
// then the result is read synchronously.
async function search(query: string) {
  const view = renderSearch();
  act(() => {
    view.result.current.setSearchQuery(query);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
  return view;
}

describe("useDriveExplorer global search", () => {
  beforeEach(async () => {
    await db.files.clear();
    delete metadataCache["f2"];
  });

  afterEach(async () => {
    await db.files.clear();
    delete metadataCache["f2"];
  });

  it("matches Vietnamese đ via normalization (file 'Đổi thay.mp3', query 'doi')", async () => {
    await db.files.bulkPut([makeFile("f1", "Đổi thay.mp3")]);
    const view = await search("doi");
    const ids = view.result.current.currentItems.map((i) => i.id);
    expect(ids).toContain("f1");
    view.unmount();
  });

  it("matches by ID3 title from metadataCache when the file name differs", async () => {
    await db.files.bulkPut([makeFile("f2", "01 - abc.mp3")]);
    metadataCache["f2"] = {
      title: "Nỗi buồn",
      artist: "Ca sĩ X",
      duration: 0,
      durationEstimated: true,
      pictureData: null,
      pictureDataFull: null,
      v: 2,
    };
    const view = await search("noi buon");
    const ids = view.result.current.currentItems.map((i) => i.id);
    expect(ids).toContain("f2");
    view.unmount();
  });

  it("matches by artist from metadataCache", async () => {
    await db.files.bulkPut([makeFile("f2", "01 - abc.mp3")]);
    metadataCache["f2"] = {
      title: "Nỗi buồn",
      artist: "Ca sĩ X",
      duration: 0,
      durationEstimated: true,
      pictureData: null,
      pictureDataFull: null,
      v: 2,
    };
    const view = await search("ca si");
    const ids = view.result.current.currentItems.map((i) => i.id);
    expect(ids).toContain("f2");
    view.unmount();
  });

  it("matches multiple space-separated tokens (AND) against the whole haystack", async () => {
    await db.files.bulkPut([
      makeFile("f3", "Anh dong vien - Yeu em.mp3"),
      makeFile("f1", "Doi thay.mp3"),
    ]);
    const view = await search("anh yeu");
    const ids = view.result.current.currentItems.map((i) => i.id);
    expect(ids).toContain("f3");
    expect(ids).not.toContain("f1");
    view.unmount();
  });

  it("returns more than the old 100-result cap (GLOBAL_SEARCH_LIMIT raised)", async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      makeFile(`limit-${String(i)}`, `limit-track-${String(i)}.mp3`),
    );
    await db.files.bulkPut(rows);
    const view = await search("limit-track");
    expect(view.result.current.filteredItems.length).toBe(120);
    view.unmount();
  });
});
