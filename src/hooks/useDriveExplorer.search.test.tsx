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
import { resetSearchWorkerState } from "../search/search.worker";

// Global search runs through the worker-backed engine (Task 3 of the search
// rebuild): in jsdom the hook takes the inline fallback path (no Worker) and
// rebuilds the MiniSearch index from the real (fake-indexeddb) tables on the
// first non-empty query of each test. resetSearchWorkerState() wipes the
// module-level index between tests so a test never serves a stale index built
// from another test's rows — table writes happen BEFORE the hook mounts, so
// the Dexie invalidation hooks cannot see them.
// The hook is rendered with token=null so the on-demand fetch effect is inert.

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
const FOLDER_MIME = "application/vnd.google-apps.folder";

function makeFile(
  id: string,
  name: string,
  opts: { isFolder?: boolean; mimeType?: string } = {},
): DriveFile {
  return {
    id,
    name,
    mimeType: opts.mimeType ?? "audio/mpeg",
    parentId: ROOT_ID,
    trashed: false,
    isFolder: opts.isFolder ?? false,
    modifiedTime: "2024-01-01T00:00:00.000Z",
    size: 1000,
  };
}

// Seeds a REAL metadata row in the IDB cache (entry.version 2, data.v 5 <
// V_PLACEHOLDER 9) — the engine indexes title/artist only from such rows.
function seedRealMetadata(id: string, title: string, artist: string) {
  return db.metadataCache.put({
    key: `metadata_${id}`,
    entry: {
      version: 2,
      data: {
        title,
        artist,
        duration: 0,
        durationEstimated: true,
        pictureData: null,
        pictureDataFull: null,
        v: 5,
      },
      ts: Date.now(),
    },
  });
}

function renderSearch() {
  return renderHook(() =>
    useDriveExplorer(ROOT_ID, "My Drive", null, () => {}),
  );
}

// Search results are debounced (DEBOUNCE_DELAY_MS = 150ms real timers) and the
// first query of a test also rebuilds the index from the tables. Sleeping
// inside act lets debounce + rebuild + query land inside act, then the result
// is read synchronously.
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
    await db.metadataCache.clear();
    resetSearchWorkerState();
  });

  afterEach(async () => {
    await db.files.clear();
    await db.metadataCache.clear();
  });

  it("matches Vietnamese đ via normalization (file 'Đổi thay.mp3', query 'doi')", async () => {
    await db.files.bulkPut([makeFile("f1", "Đổi thay.mp3")]);
    const view = await search("doi");
    const ids = view.result.current.currentItems.map((i) => i.id);
    expect(ids).toContain("f1");
    view.unmount();
  });

  it("matches by a REAL ID3 title seeded via db.metadataCache (IDB) when the file name differs", async () => {
    await db.files.bulkPut([makeFile("f2", "01 - abc.mp3")]);
    await seedRealMetadata("f2", "Nỗi buồn", "Ca sĩ X");
    const view = await search("noi buon");
    const ids = view.result.current.currentItems.map((i) => i.id);
    expect(ids).toContain("f2");
    // display title/artist come from the real metadata, not the filename
    const hit = view.result.current.filteredItems.find((i) => i.id === "f2");
    expect(hit?.title).toBe("Nỗi buồn");
    expect(hit?.trackInfo?.artist).toBe("Ca sĩ X");
    expect(hit?.trackInfo?.parentName).toBe("Search Result");
    view.unmount();
  });

  it("matches by a REAL artist seeded via db.metadataCache (IDB)", async () => {
    await db.files.bulkPut([makeFile("f2", "01 - abc.mp3")]);
    await seedRealMetadata("f2", "Nỗi buồn", "Ca sĩ X");
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

  it("finds folders by name and lists them before files (query 'nhac')", async () => {
    await db.files.bulkPut([
      makeFile("fol", "Nhạc Việt", { isFolder: true, mimeType: FOLDER_MIME }),
      makeFile("f1", "Nhac vang.mp3"),
    ]);
    const view = await search("nhac");
    const items = view.result.current.filteredItems;
    const ids = items.map((i) => i.id);
    expect(ids).toContain("fol");
    expect(ids).toContain("f1");
    expect(ids.indexOf("fol")).toBeLessThan(ids.indexOf("f1"));
    const folder = items.find((i) => i.id === "fol");
    expect(folder?.isFolder).toBe(true);
    // folders keep their full name as title and carry no trackInfo
    expect(folder?.title).toBe("Nhạc Việt");
    expect(folder?.trackInfo).toBeUndefined();
    const file = items.find((i) => i.id === "f1");
    expect(file?.title).toBe("Nhac vang");
    expect(file?.trackInfo?.parentName).toBe("Search Result");
    view.unmount();
  });

  it("ranks an exact name match first (query 'anh' -> 'Anh.mp3' head)", async () => {
    await db.files.bulkPut([
      makeFile("f-exact", "Anh.mp3"),
      makeFile("f-partial-3", "Anh yeu em.mp3"),
      makeFile("f-partial-2", "Yeu anh.mp3"),
    ]);
    const view = await search("anh");
    const ids = view.result.current.filteredItems.map((i) => i.id);
    expect(ids[0]).toBe("f-exact");
    // Full order pinned to the engine's actual ranking (verified empirically
    // against minisearch: BM25 length normalization puts the shorter 2-token
    // name above the 3-token one — both partials are below the exact match).
    expect(ids).toEqual(["f-exact", "f-partial-2", "f-partial-3"]);
    view.unmount();
  });

  it("ranks by relevance score desc, not alphabetically, when no exact match exists", async () => {
    await db.files.bulkPut([
      makeFile("f-a", "Anh yeu em.mp3"),
      makeFile("f-b", "Yeu anh.mp3"),
    ]);
    const view = await search("anh");
    // Alphabetical would be [Anh yeu em, Yeu anh]; BM25 length normalization
    // puts the shorter 'Yeu anh' first — the deliberate relevance change.
    expect(view.result.current.filteredItems.map((i) => i.id)).toEqual([
      "f-b",
      "f-a",
    ]);
    view.unmount();
  });

  it("does not treat placeholder metadata (v:9) as searchable content", async () => {
    await db.files.bulkPut([makeFile("f3", "02 - xyz.mp3")]);
    await db.metadataCache.put({
      key: "metadata_f3",
      entry: {
        version: 2,
        data: {
          title: "02 - xyz",
          artist: "Unknown Artist",
          duration: 0,
          durationEstimated: true,
          pictureData: null,
          pictureDataFull: null,
          v: 9,
        },
        ts: Date.now(),
      },
    });
    const view = await search("unknown artist");
    expect(view.result.current.filteredItems).toEqual([]);
    view.unmount();
    // the filename itself stays searchable regardless of metadata status
    const view2 = await search("02 xyz");
    expect(view2.result.current.filteredItems.map((i) => i.id)).toContain("f3");
    view2.unmount();
  });

  it("shows the normal folder listing when the query is empty (no search runs)", async () => {
    await db.files.bulkPut([makeFile("f1", "B.mp3"), makeFile("f2", "A.mp3")]);
    const view = renderSearch();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    // listing sorted by name (name_natural): A.mp3 before B.mp3
    expect(view.result.current.filteredItems.map((i) => i.id)).toEqual([
      "f2",
      "f1",
    ]);
    view.unmount();
  });

  it("treats a whitespace-only query as empty (normal listing, no search)", async () => {
    await db.files.bulkPut([makeFile("f1", "A.mp3")]);
    const view = renderSearch();
    act(() => {
      view.result.current.setSearchQuery("   ");
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(view.result.current.filteredItems.map((i) => i.id)).toEqual(["f1"]);
    view.unmount();
  });
});
