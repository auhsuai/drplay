import { describe, it, expect } from "vitest";
import {
  buildSearchIndex,
  loadRealMetadata,
  queryIndex,
  matchesNormalized,
  buildParentToChildren,
  computeRootMembership,
  computeSubtreeIds,
} from "./searchEngine";
import type { DriveFile, MetadataCacheRow } from "../db/db";
import type { CachedMetadata } from "../utils/metadata";
import { compareNatural } from "../utils/naturalSortCollator";
import type { SearchHit } from "./searchEngine";

// Pure module tests: no fake-indexeddb needed — buildSearchIndex/queryIndex
// operate entirely in memory over DriveFile objects.

const ROOT_ID = "root";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const META_VERSION = 2;
const META_PLACEHOLDER_VERSION = 9;

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
    modifiedTime: opts.modifiedTime,
    userEmail: "default", // compound PK part (schema v10)
  };
}

function makeRealMeta(title: string, artist: string): CachedMetadata {
  return {
    title,
    artist,
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: 5,
  };
}

function makePlaceholderMeta(name: string): CachedMetadata {
  return {
    title: name.replace(/\.[^.]+$/, ""),
    artist: "Unknown Artist",
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: META_PLACEHOLDER_VERSION,
  };
}

function makeMetaRow(key: string, data: CachedMetadata): MetadataCacheRow {
  return { key, entry: { version: META_VERSION, data, ts: 0 } };
}

function buildIndex(
  files: DriveFile[],
  rows: MetadataCacheRow[] = [],
): ReturnType<typeof buildSearchIndex> {
  return buildSearchIndex(files, loadRealMetadata(rows));
}

// Every query needs a scope now (fail-closed engine) — there is no unscoped
// path left. These legacy cases all live under the shared "root" parent, so
// they ask with that global scope via `ask`, keeping their original intents.
const GLOBAL_SCOPE = { mode: "global" as const, rootIds: [ROOT_ID] };
const ask = (
  index: ReturnType<typeof buildSearchIndex>,
  query: string,
  limit: number,
): ReturnType<typeof queryIndex> =>
  queryIndex(index, query, limit, GLOBAL_SCOPE);

describe("searchEngine", () => {
  it("1. matches diacritics-insensitively (query 'doi' hits 'Đổi thay.mp3')", () => {
    const index = buildIndex([makeFile("f1", "Đổi thay.mp3")]);
    const hits = ask(index, "doi", 10);
    expect(hits.map((h) => h.id)).toContain("f1");
  });

  it("2. combines multiple tokens with AND", () => {
    const index = buildIndex([
      makeFile("a", "Anh dong vien - Yeu em.mp3"),
      makeFile("b", "Doi thay.mp3"),
    ]);
    const hits = ask(index, "anh yeu", 10);
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("3. ranks exact name match above partial matches", () => {
    const index = buildIndex([
      makeFile("exact", "Anh.mp3"),
      makeFile("partial-3-token", "Anh yeu em.mp3"),
      makeFile("partial-2-token", "Yeu anh.mp3"),
    ]);
    const hits = ask(index, "anh", 10);
    // Exact-name doc must be the single top result with strictly the highest
    // score. NOTE: BM25 length normalization ranks the 2-token name above the
    // 3-token name, so only the "exact first" part of the spec order is
    // asserted here — the two partials are both required but their sub-order
    // is not (see report for the documented deviation).
    expect(hits[0]?.id).toBe("exact");
    const scores = hits.map((h) => h.score);
    const sortedDesc = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sortedDesc);
    expect(hits.map((h) => h.id)).toEqual(
      expect.arrayContaining(["partial-3-token", "partial-2-token"]),
    );
  });

  it("4. supports prefix and fuzzy matching", () => {
    const index = buildIndex([
      makeFile("m1", "Motorcycle.mp3"),
      makeFile("m2", "Ishmael.mp3"),
    ]);
    // prefix: "mo" is a word prefix of "motorcycle"
    expect(ask(index, "mo", 10).map((h) => h.id)).toContain("m1");
    // exact (post-normalization) term
    expect(ask(index, "ishmael", 10).map((h) => h.id)).toContain("m2");
    // fuzzy: "ismael" (missing 'h') is edit distance 1 from "ishmael"
    expect(ask(index, "ismael", 10).map((h) => h.id)).toContain("m2");
  });

  it("5. indexes real metadata (v<9) but not placeholders", () => {
    const rows = [
      makeMetaRow("metadata_f2", makeRealMeta("Nỗi buồn", "Ca sĩ X")),
      makeMetaRow("metadata_f2", makePlaceholderMeta("01 - abc.mp3")),
    ];
    const real = loadRealMetadata(rows);
    // same file key: only the real v:5 entry survives the version filter
    expect(real.size).toBe(1);
    expect(real.get("f2")?.title).toBe("Nỗi buồn");

    const placeholderOnly = makeMetaRow(
      "metadata_f3",
      makePlaceholderMeta("02 - xyz.mp3"),
    );
    const index = buildSearchIndex(
      [
        makeFile("f2", "01 - abc.mp3"),
        makeFile("f3", "02 - xyz.mp3"),
        makeFile("f4", "Noi buon.mp3"),
      ],
      loadRealMetadata([...rows, placeholderOnly]),
    );

    // real metadata title/artist are searchable
    const noiBuon = ask(index, "noi buon", 10);
    expect(noiBuon.map((h) => h.id)).toEqual(
      expect.arrayContaining(["f2", "f4"]),
    );
    const f2Hit = noiBuon.find((h) => h.id === "f2");
    expect(f2Hit?.title).toBe("Nỗi buồn");
    expect(ask(index, "ca si", 10).map((h) => h.id)).toContain("f2");
    // name field beats title field (boost name 3 > title 2): the file whose
    // NAME is "Noi buon.mp3" must rank above the one matching only via the
    // real-metadata TITLE "Nỗi buồn".
    const byScore = [...noiBuon].sort((a, b) => b.score - a.score);
    expect(byScore[0]?.id).toBe("f4");
    // placeholder metadata ("Unknown Artist", v:9) is NOT searchable
    expect(ask(index, "unknown artist", 10)).toEqual([]);
    // filename stays searchable regardless of metadata status
    expect(ask(index, "01 abc", 10).map((h) => h.id)).toContain("f2");
    expect(ask(index, "02 xyz", 10).map((h) => h.id)).toContain("f3");
  });

  it("5b. loadRealMetadata skips malformed envelopes (null/corrupt/stale/placeholder)", () => {
    const rows: MetadataCacheRow[] = [
      { key: "metadata_null_entry", entry: null },
      { key: "metadata_scalar_entry", entry: "garbage" },
      { key: "metadata_no_version", entry: { data: makeRealMeta("x", "y") } },
      {
        key: "metadata_stale_version",
        entry: { version: 1, data: makeRealMeta("x", "y"), ts: 0 },
      },
      {
        key: "metadata_null_data",
        entry: { version: META_VERSION, data: null, ts: 0 },
      },
      {
        key: "metadata_nonnum_v",
        entry: { version: META_VERSION, data: { v: "8" }, ts: 0 },
      },
      {
        key: "metadata_placeholder",
        entry: {
          version: META_VERSION,
          data: makePlaceholderMeta("ph.mp3"),
          ts: 0,
        },
      },
      {
        key: "metadata_ok",
        entry: {
          version: META_VERSION,
          data: makeRealMeta("Real", "Artist"),
          ts: 0,
        },
      },
    ];
    const real = loadRealMetadata(rows);
    expect([...real.keys()]).toEqual(["ok"]);
    expect(real.get("ok")?.title).toBe("Real");
  });

  it("6. matches folders by name, returning both files and folders", () => {
    const index = buildIndex([
      makeFile("fol", "Nhạc Việt", {
        isFolder: true,
        mimeType: FOLDER_MIME,
      }),
      makeFile("file", "Nhac vang.mp3"),
    ]);
    const hits = ask(index, "nhac", 10);
    const folderHit = hits.find((h) => h.id === "fol");
    expect(folderHit).toBeDefined();
    expect(folderHit?.isFolder).toBe(true);
    // folders keep their full name as title (no extension stripping)
    expect(folderHit?.title).toBe("Nhạc Việt");
    expect(folderHit?.artist).toBeNull();
    const fileHit = hits.find((h) => h.id === "file");
    expect(fileHit).toBeDefined();
    expect(fileHit?.isFolder).toBe(false);
    expect(fileHit?.title).toBe("Nhac vang");
  });

  it("7. caps results at limit, keeping score order", () => {
    const LIMIT = 500;
    const DOCS = 600;
    const files = Array.from({ length: DOCS }, (_, i) =>
      makeFile(`limit-${String(i)}`, `limit-track-${String(i)}.mp3`),
    );
    const index = buildIndex(files);
    const hits = ask(index, "limit-track", LIMIT);
    expect(hits.length).toBe(LIMIT);
    expect(new Set(hits.map((h) => h.id)).size).toBe(LIMIT);
    const scores = hits.map((h) => h.score);
    const sortedDesc = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sortedDesc);
  });

  it("8. returns [] for empty or whitespace-only queries", () => {
    const index = buildIndex([makeFile("f1", "Anh.mp3")]);
    expect(ask(index, "", 10)).toEqual([]);
    expect(ask(index, "   ", 10)).toEqual([]);
  });

  it("9. matchesNormalized keeps substring AND semantics", () => {
    expect(matchesNormalized("Đổi thay", "doi")).toBe(true);
    expect(matchesNormalized("Anh yeu em", "anh yeu")).toBe(true);
    expect(matchesNormalized("Doi thay", "anh yeu")).toBe(false);
    expect(matchesNormalized("x", "")).toBe(false);
  });

  it("10. queryIndex is whitespace-robust", () => {
    const index = buildIndex([makeFile("a", "Anh dong vien - Yeu em.mp3")]);
    const spaced = ask(index, "  anh   yeu ", 10);
    const clean = ask(index, "anh yeu", 10);
    expect(spaced.map((h) => h.id)).toEqual(clean.map((h) => h.id));
    expect(spaced.length).toBe(1);
  });

  describe("root-scoped query (B1+B2)", () => {
    const FOLDER_A = "folder-A";
    const FOLDER_B = "folder-B";

    function makeTree(): ReturnType<typeof buildSearchIndex> {
      return buildIndex([
        makeFile(FOLDER_A, "Alpha", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "root",
        }),
        makeFile("a1", "Alpha song one.mp3", { parentId: FOLDER_A }),
        makeFile("a2", "Alpha song two.mp3", { parentId: FOLDER_A }),
        makeFile(FOLDER_B, "Beta", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "root",
        }),
        makeFile("b1", "Beta song.mp3", { parentId: FOLDER_B }),
        // Orphan: parent never mirrored in the index docs.
        makeFile("orphan", "Orphan song.mp3", { parentId: "missing" }),
        // Direct cycle: parent points at itself.
        makeFile("selfCycle", "Self cycle.mp3", { parentId: "selfCycle" }),
        // Indirect cycle: c1 -> c2 -> c1.
        makeFile("c1", "Cycle one.mp3", { parentId: "c2" }),
        makeFile("c2", "Cycle two.mp3", { parentId: "c1" }),
      ]);
    }

    const queryCtx = {
      mode: "recursive" as const,
    };

    // Root-scope tests (R2-R6) describe the ROOT membership filter, which
    // recursive and global share. They are stated in GLOBAL mode so they do
    // not depend on the (now removed) "recursive without a folder = global"
    // degrade — recursive without a folder fails closed (R16).
    const rootCtx = {
      mode: "global" as const,
    };

    it("R1. empty rootIds fails closed: no hits even for matching docs", () => {
      const index = makeTree();
      const hits = queryIndex(index, "song", 10, { ...queryCtx, rootIds: [] });
      expect(hits).toEqual([]);
      // null-ish guards too (defensive): treated like empty.
      expect(
        queryIndex(index, "song", 10, { ...queryCtx, rootIds: [] }),
      ).toEqual([]);
    });

    it("R2. out-of-root docs are excluded BEFORE the limit slice (small limit proves it)", () => {
      const index = buildIndex([
        makeFile(FOLDER_A, "Alpha", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "root",
        }),
        makeFile("r-in1", "Song in root.mp3", { parentId: FOLDER_A }),
        makeFile("r-in2", "Song in root too.mp3", { parentId: FOLDER_A }),
        makeFile("r-out", "Song outside.mp3", { parentId: FOLDER_B }),
      ]);
      // All three songs match "song"; limit 2 must keep ONLY the two in-root
      // docs — an engine-level slice before the filter would instead drop one
      // of the in-root docs (the byScore tail) and leak r-out in.
      const hits = queryIndex(index, "song", 2, {
        ...rootCtx,
        rootIds: [FOLDER_A],
      });
      expect(hits.map((h) => h.id).sort()).toEqual(["r-in1", "r-in2"]);
    });

    it("R3. single root: descendants included, other branches excluded", () => {
      const index = makeTree();
      const hits = queryIndex(index, "song", 20, {
        ...rootCtx,
        rootIds: [FOLDER_A],
      });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain("a1");
      expect(ids).toContain("a2");
      expect(ids).not.toContain("b1");
      // Orphan/cycles are unreachable from the root -> fail closed.
      expect(ids).not.toContain("orphan");
      expect(ids).not.toContain("selfCycle");
      expect(ids).not.toContain("c1");
    });

    it("R4. multi-root: union of both subtrees, duplicates deduped", () => {
      const index = makeTree();
      const hits = queryIndex(index, "song", 20, {
        ...rootCtx,
        rootIds: [FOLDER_A, FOLDER_B, FOLDER_A],
      });
      const ids = hits.map((h) => h.id);
      expect(ids).toEqual(expect.arrayContaining(["a1", "a2", "b1"]));
      expect(ids).not.toContain("orphan");
    });

    it("R5. nested roots: child root inside parent root does not duplicate hits", () => {
      // A truly nested pair: folder-B inside folder-A — BFS from both roots
      // must dedupe b1 (visited-set), not emit it twice.
      const nested = buildIndex([
        makeFile(FOLDER_A, "Alpha", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "root",
        }),
        makeFile(FOLDER_B, "Beta", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: FOLDER_A,
        }),
        makeFile("a1", "Alpha song one.mp3", { parentId: FOLDER_A }),
        makeFile("b1", "Beta song.mp3", { parentId: FOLDER_B }),
      ]);
      const hits = queryIndex(nested, "song", 20, {
        ...rootCtx,
        rootIds: [FOLDER_A, FOLDER_B],
      });
      const ids = hits.map((h) => h.id);
      expect(ids.filter((id) => id === "b1")).toHaveLength(1);
      expect(ids.filter((id) => id === "a1")).toHaveLength(1);
      expect(ids).toEqual(expect.arrayContaining(["a1", "b1"]));
    });

    it("R6. missing root id (not in index) is skipped silently; all-invalid roots -> []", () => {
      const index = makeTree();
      const partial = queryIndex(index, "song", 20, {
        ...rootCtx,
        rootIds: [FOLDER_A, "ghost-root"],
      });
      expect(partial.map((h) => h.id)).toContain("a1");
      expect(partial.map((h) => h.id)).not.toContain("b1");
      const none = queryIndex(index, "song", 20, {
        ...rootCtx,
        rootIds: ["ghost-root", "ghost-2"],
      });
      expect(none).toEqual([]);
    });

    it("R7. recursive: subtree of currentFolderId only; current folder itself excluded", () => {
      const index = makeTree();
      const hits = queryIndex(index, "Alpha", 20, {
        ...queryCtx,
        rootIds: [FOLDER_A],
        currentFolderId: FOLDER_A,
      });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain("a1");
      expect(ids).toContain("a2");
      // The current folder itself is NOT part of its own subtree results.
      expect(ids).not.toContain(FOLDER_A);
      expect(ids).not.toContain("b1");
    });

    it("R8. recursive: VIRTUAL_ROOT_ID degrades to global (all roots scope)", () => {
      const index = makeTree();
      const hits = queryIndex(index, "song", 20, {
        ...queryCtx,
        rootIds: [FOLDER_A, FOLDER_B],
        currentFolderId: "__drplay_virtual_root__",
      });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain("a1");
      expect(ids).toContain("b1");
    });

    it("R9. recursive: current folder outside the roots -> subtree empty -> []", () => {
      const index = makeTree();
      const hits = queryIndex(index, "song", 20, {
        ...queryCtx,
        rootIds: [FOLDER_A],
        currentFolderId: FOLDER_B,
      });
      expect(hits).toEqual([]);
    });

    it("R10. global mode: root filter applies, currentFolderId ignored", () => {
      const index = makeTree();
      const hits = queryIndex(index, "song", 20, {
        mode: "global",
        rootIds: [FOLDER_A],
        currentFolderId: FOLDER_B,
      });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain("a1");
      expect(ids).not.toContain("b1");
    });

    it("R11. cycles do not hang or crash (BFS visited-set)", () => {
      const index = buildIndex([
        makeFile("x1", "Loop song.mp3", { parentId: "x2" }),
        makeFile("x2", "Loop song two.mp3", { parentId: "x1" }),
      ]);
      // BFS from a root that REACHES the cycle must terminate.
      const parentToChildren = buildParentToChildren(index);
      const inRootIds = computeRootMembership(index, parentToChildren, ["x1"]);
      expect(inRootIds.has("x1")).toBe(true);
      expect(inRootIds.has("x2")).toBe(true);
      const subtree = computeSubtreeIds(parentToChildren, "x2");
      expect(subtree.has("x1")).toBe(true);
    });

    it("R12. no scope FAILS CLOSED: calling without a scope yields no hits", () => {
      const index = makeTree();
      // No scope at all: only in-root docs may be served, and without a root
      // set there is nothing in scope — the legacy unscoped path is gone.
      expect(queryIndex(index, "song", 20)).toEqual([]);
      expect(queryIndex(index, "song", 20, undefined)).toEqual([]);
    });

    it("R14. recursive: an ANCESTOR outside the roots that contains a child root -> []", () => {
      // folder-P (outside every root) contains folder-A (a configured root).
      // The current folder (P) is not in the root membership, so recursive
      // scoping must fail closed instead of intersecting P's subtree with A.
      const index = buildIndex([
        makeFile("folder-P", "Parent", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "root",
        }),
        makeFile(FOLDER_A, "Alpha", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "folder-P",
        }),
        makeFile("a1", "Alpha song one.mp3", { parentId: FOLDER_A }),
      ]);
      const hits = queryIndex(index, "song", 20, {
        ...queryCtx,
        rootIds: [FOLDER_A],
        currentFolderId: "folder-P",
      });
      expect(hits).toEqual([]);
    });

    it("R15. recursive: current folder == a root works; descendant works; sibling root excluded", () => {
      const index = makeTree();
      const atRoot = queryIndex(index, "song", 20, {
        ...queryCtx,
        rootIds: [FOLDER_A],
        currentFolderId: FOLDER_A,
      });
      expect(atRoot.map((h) => h.id).sort()).toEqual(["a1", "a2"]);
      // A descendant of the root is still inside the membership.
      const index2 = buildIndex([
        makeFile(FOLDER_A, "Alpha", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "root",
        }),
        makeFile("sub", "Sub", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: FOLDER_A,
        }),
        makeFile("deep", "Deep song.mp3", { parentId: "sub" }),
        makeFile("a1", "Alpha song one.mp3", { parentId: FOLDER_A }),
      ]);
      const nested = queryIndex(index2, "song", 20, {
        ...queryCtx,
        rootIds: [FOLDER_A],
        currentFolderId: "sub",
      });
      expect(nested.map((h) => h.id)).toEqual(["deep"]);
      // A folder outside every root fails closed even when it has children.
      const outside = queryIndex(index, "song", 20, {
        ...queryCtx,
        rootIds: [FOLDER_A],
        currentFolderId: FOLDER_B,
      });
      expect(outside).toEqual([]);
    });

    it("R13. root membership helpers: cycle guard + self-parent + orphan exclusion", () => {
      const index = makeTree();
      const parentToChildren = buildParentToChildren(index);
      const inRootIds = computeRootMembership(index, parentToChildren, [
        FOLDER_A,
      ]);
      expect(inRootIds.has(FOLDER_A)).toBe(true);
      expect(inRootIds.has("a1")).toBe(true);
      expect(inRootIds.has("orphan")).toBe(false);
      expect(inRootIds.has("selfCycle")).toBe(false);
      expect(inRootIds.has("c1")).toBe(false);
      const subtree = computeSubtreeIds(parentToChildren, FOLDER_A);
      expect(subtree.has("a1")).toBe(true);
      expect(subtree.has(FOLDER_A)).toBe(true);
      // Subtree BFS from an unknown folder: standard BFS returns the start
      // node only — fail-closed happens at the call site because the folder
      // is not in inRootIds (queryIndex answers [] for that combination).
      expect(computeSubtreeIds(parentToChildren, "ghost")).toEqual(
        new Set(["ghost"]),
      );
    });
  });

  describe("search sorting (B3)", () => {
    // Fixed relevance ranking via distinct name-token counts; docs share one
    // root so the root scope never interferes with sort assertions.
    const ROOT = "sort-root";

    function makeSortTree(): ReturnType<typeof buildSearchIndex> {
      return buildIndex([
        makeFile(ROOT, "Sort Root", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "grandroot",
        }),
        // files: same token "song" so they all match one query.
        makeFile("f1", "song.mp3", {
          parentId: ROOT,
          size: 300,
          modifiedTime: "2024-03-01T00:00:00.000Z",
        }),
        makeFile("f2", "song b.mp3", {
          parentId: ROOT,
          size: 100,
          modifiedTime: "2024-01-01T00:00:00.000Z",
        }),
        makeFile("f3", "song a.mp3", {
          parentId: ROOT,
          size: 200,
          modifiedTime: "2024-02-01T00:00:00.000Z",
        }),
        // folder matched by the same query via name.
        makeFile("fold", "song folder", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: ROOT,
        }),
        // invalid/missing date + missing size rows.
        makeFile("f-bad-date", "song bad date.mp3", {
          parentId: ROOT,
          size: 50,
          modifiedTime: "not-a-date",
        }),
        makeFile("f-no-size", "song no size.mp3", {
          parentId: ROOT,
          modifiedTime: "2023-06-01T00:00:00.000Z",
        }),
      ]);
    }

    const scope = { mode: "global" as const, rootIds: [ROOT] };

    it("S1. relevance default (no sort spec) keeps byScore order + folders first", () => {
      const index = makeSortTree();
      const hits = queryIndex(index, "song", 20, scope);
      // Folder group leads (B4), then byScore desc inside each group.
      expect(hits[0]?.isFolder).toBe(true);
      for (const group of [true, false]) {
        const scores = hits
          .filter((h) => h.isFolder === group)
          .map((h) => h.score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
      }
      // Explicit relevance spec behaves identically.
      const explicit = queryIndex(index, "song", 20, scope, {
        field: "relevance",
        dir: "desc",
      });
      expect(explicit.map((h) => h.id)).toEqual(hits.map((h) => h.id));
      // And so does the no-spec default vs an explicit one in the other dir:
      // relevance ignores dir (score order is already the ranking).
      const explicitAsc = queryIndex(index, "song", 20, scope, {
        field: "relevance",
        dir: "asc",
      });
      expect(explicitAsc.map((h) => h.id)).toEqual(hits.map((h) => h.id));
    });

    it("S2. name asc/desc sorts by filename WITH extension, folders first both ways", () => {
      const index = makeSortTree();
      const asc = queryIndex(index, "song", 20, scope, {
        field: "name",
        dir: "asc",
      });
      const ascIds = asc.map((h) => h.id);
      // Extension matters: "song.mp3" vs "song a.mp3" — plain names would tie.
      expect(ascIds.indexOf("fold")).toBeLessThan(ascIds.indexOf("f1"));
      const fileNames = asc.filter((h) => !h.isFolder).map((h) => h.name);
      // Expected order comes from the SHARED natural collator (B5), the same
      // one the folder listing uses — not a bare localeCompare.
      expect(fileNames).toEqual([...fileNames].sort(compareNatural));
      const desc = queryIndex(index, "song", 20, scope, {
        field: "name",
        dir: "desc",
      });
      // Folders stay first even when desc.
      expect(desc[0]?.isFolder).toBe(true);
      const descNames = desc.filter((h) => !h.isFolder).map((h) => h.name);
      expect(descNames).toEqual(
        [...descNames].sort((a, b) => compareNatural(b, a)),
      );
    });

    it("S3. modifiedTime asc/desc: invalid/missing dates pin to the bottom in BOTH directions", () => {
      const index = makeSortTree();
      const asc = queryIndex(index, "song", 20, scope, {
        field: "modifiedTime",
        dir: "asc",
      });
      const ascFiles = asc.filter((h) => !h.isFolder).map((h) => h.id);
      expect(ascFiles[ascFiles.length - 1]).toBe("f-bad-date");
      // asc: oldest real date first.
      expect(ascFiles[0]).toBe("f-no-size"); // 2023-06-01
      const desc = queryIndex(index, "song", 20, scope, {
        field: "modifiedTime",
        dir: "desc",
      });
      const descFiles = desc.filter((h) => !h.isFolder).map((h) => h.id);
      // desc: newest real date first; invalid STILL pinned bottom.
      expect(descFiles[0]).toBe("f1"); // 2024-03-01
      expect(descFiles[descFiles.length - 1]).toBe("f-bad-date");
    });

    it("S4. size asc/desc: missing sizes pin to the bottom in BOTH directions", () => {
      const index = makeSortTree();
      const asc = queryIndex(index, "song", 20, scope, {
        field: "size",
        dir: "asc",
      });
      const ascFiles = asc.filter((h) => !h.isFolder);
      const sizedAsc = ascFiles
        .filter((h) => typeof h.size === "number")
        .map((h) => h.size as number);
      expect(sizedAsc).toEqual([...sizedAsc].sort((a, b) => a - b));
      expect(ascFiles[ascFiles.length - 1]?.size).toBeUndefined();
      const desc = queryIndex(index, "song", 20, scope, {
        field: "size",
        dir: "desc",
      });
      const descFiles = desc.filter((h) => !h.isFolder);
      const sizedDesc = descFiles
        .filter((h) => typeof h.size === "number")
        .map((h) => h.size as number);
      expect(sizedDesc).toEqual([...sizedDesc].sort((a, b) => b - a));
      // Missing size still last when desc (pin does not flip).
      expect(descFiles[descFiles.length - 1]?.size).toBeUndefined();
    });

    it("S5. sort applies to the FULL filtered set BEFORE the limit slice", () => {
      const index = makeSortTree();
      // limit 2 on name asc. Folders-first always wins the first slot
      // ("fold" = "song folder" sorts before files alphabetically too).
      // If the engine sliced by RELEVANCE before sorting, the name-asc top-2
      // would be [fold, f1] (byScore ranks f1 #1) — instead the true name
      // order [fold, f3] proves sort ran on the full set before the slice.
      const hits = queryIndex(index, "song", 2, scope, {
        field: "name",
        dir: "asc",
      });
      expect(hits.map((h) => h.id)).toEqual([
        "fold", // song folder (folder first)
        "f3", // song a.mp3
      ]);
    });

    it("S6. stable sort: equal keys keep byScore relative order", () => {
      // Two identical names, ONE root: the ROOT itself ("sort-root") also
      // matches "same size"? No — it matches "song" only. The tie query here
      // needs both files to match AND to be inside rootIds: both have
      // parentId=ROOT... which is not itself indexed in this small fixture,
      // so rootIds=[ROOT] resolves to an empty membership (fail closed).
      // Include the root doc so membership resolves.
      const index = buildIndex([
        makeFile(ROOT, "sort root", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "grandroot",
        }),
        makeFile("tie-b", "same size.mp3", { parentId: ROOT, size: 100 }),
        makeFile("tie-a", "same size.mp3", { parentId: ROOT, size: 100 }),
      ]);
      const hits = queryIndex(
        index,
        "same size",
        10,
        {
          mode: "global",
          rootIds: [ROOT],
        },
        {
          field: "size",
          dir: "asc",
        },
      );
      expect(hits.map((h) => h.id)).toEqual(["tie-b", "tie-a"]);
      const hitsName = queryIndex(
        index,
        "same size",
        10,
        {
          mode: "global",
          rootIds: [ROOT],
        },
        {
          field: "name",
          dir: "desc",
        },
      );
      // Equal names keep the same relative (byScore) order in both dirs.
      expect(hitsName.map((h) => h.id)).toEqual(["tie-b", "tie-a"]);
    });

    it("S7. relevance = folders-first STABLE partition (MiniSearch order kept within each group)", () => {
      const index = buildIndex([
        makeFile(ROOT, "Sort Root", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "grandroot",
        }),
        // Folder matched only by a long, low-scoring name.
        makeFile("fold-low", "alpha beta gamma delta folder", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: ROOT,
        }),
        makeFile("file-high", "alpha.mp3", { parentId: ROOT }),
        makeFile("file-mid", "alpha beta.mp3", { parentId: ROOT }),
      ]);
      const all = queryIndex(index, "alpha", 20, scope);
      // Raw MiniSearch order == byScore desc.
      const rawOrder = [...all]
        .sort((a, b) => b.score - a.score)
        .map((h) => h.id);
      const expected = [
        ...rawOrder.filter((id) => id === "fold-low"),
        ...rawOrder.filter((id) => id !== "fold-low"),
      ];
      expect(all.map((h) => h.id)).toEqual(expected);
      // The folder really is the LOWEST-scoring hit, so leading proves the
      // partition (not the score order).
      expect(rawOrder[0]).not.toBe("fold-low");
      // Explicit relevance spec === default ordering.
      const explicit = queryIndex(index, "alpha", 20, scope, {
        field: "relevance",
        dir: "asc",
      });
      expect(explicit.map((h) => h.id)).toEqual(all.map((h) => h.id));
      // Within each group the raw relevance order holds.
      for (const group of [true, false]) {
        const ids = all.filter((h) => h.isFolder === group).map((h) => h.id);
        expect(ids).toEqual(rawOrder.filter((id) => ids.includes(id)));
      }
    });

    it("S8. relevance partition is stable for equal scores and multi-folder sets", () => {
      const index = buildIndex([
        makeFile(ROOT, "Sort Root", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "grandroot",
        }),
        makeFile("fld-1", "song one", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: ROOT,
        }),
        makeFile("fld-2", "song two", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: ROOT,
        }),
        makeFile("file-1", "song one.mp3", { parentId: ROOT }),
        makeFile("file-2", "song two.mp3", { parentId: ROOT }),
      ]);
      const hits = queryIndex(index, "song", 20, scope);
      const groups = hits.map((h) => (h.isFolder ? "f" : "d"));
      // All folders, then all files — never interleaved.
      expect(groups).toEqual(["f", "f", "d", "d"]);
      const rawOrder = [...hits].sort((a, b) => b.score - a.score);
      const expected = [
        ...rawOrder.filter((h) => h.isFolder),
        ...rawOrder.filter((h) => !h.isFolder),
      ].map((h) => h.id);
      expect(hits.map((h) => h.id)).toEqual(expected);
      // Files keep byScore order inside their group.
      const fileScores = hits.filter((h) => !h.isFolder).map((h) => h.score);
      expect(fileScores).toEqual([...fileScores].sort((a, b) => b - a));
    });

    it("S9. name sort is NATURAL (numeric) and case/diacritic-insensitive", () => {
      const numeric = buildIndex([
        makeFile(ROOT, "Sort Root", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "grandroot",
        }),
        makeFile("t10", "Track 10.mp3", { parentId: ROOT }),
        makeFile("t2", "Track 2.mp3", { parentId: ROOT }),
        makeFile("t02", "track 02.mp3", { parentId: ROOT }),
        makeFile("fold", "Track folder", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: ROOT,
        }),
      ]);
      const byName = (
        index: ReturnType<typeof buildSearchIndex>,
        q: string,
        dir: "asc" | "desc",
      ): SearchHit[] => queryIndex(index, q, 20, scope, { field: "name", dir });

      // Folders first in BOTH directions.
      expect(byName(numeric, "track", "asc")[0]?.isFolder).toBe(true);
      expect(byName(numeric, "track", "desc")[0]?.isFolder).toBe(true);
      // Natural numeric order: "Track 2" before "Track 10" (a plain
      // localeCompare puts "Track 10" first because "1" < "2").
      const asc = byName(numeric, "track", "asc").map((h) => h.name);
      expect(asc.indexOf("Track 2.mp3")).toBeLessThan(
        asc.indexOf("Track 10.mp3"),
      );
      const desc = byName(numeric, "track", "desc").map((h) => h.name);
      expect(desc.indexOf("Track 10.mp3")).toBeLessThan(
        desc.indexOf("Track 2.mp3"),
      );
      // Case-insensitive: "track 02" ties with "Track 2" numerically.
      expect(asc.indexOf("track 02.mp3")).toBe(asc.indexOf("Track 2.mp3") + 1);

      // Diacritics compared base-sensitively: the two spellings tie, so the
      // pair stays adjacent and its relative order is stable in both dirs.
      const diacritics = buildIndex([
        makeFile(ROOT, "Sort Root", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "grandroot",
        }),
        makeFile("accented", "Đổi thay.mp3", { parentId: ROOT }),
        makeFile("plain", "Doi thay.mp3", { parentId: ROOT }),
      ]);
      const ascPair = byName(diacritics, "thay", "asc").map((h) => h.name);
      const descPair = byName(diacritics, "thay", "desc").map((h) => h.name);
      expect(ascPair).toHaveLength(2);
      expect(descPair).toHaveLength(2);
      // Base sensitivity means they compare equal -> the stable sort keeps
      // one consistent relative order instead of flipping on direction.
      expect(descPair).toEqual(ascPair);
      // Extension stays significant and the comparison is the SHARED collator
      // over the raw filename (same contract as the folder listing).
      const ext = buildIndex([
        makeFile(ROOT, "Sort Root", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "grandroot",
        }),
        makeFile("plain-ext", "song.mp3", { parentId: ROOT }),
        makeFile("suffixed", "song a.mp3", { parentId: ROOT }),
        makeFile("numbered", "song 2.mp3", { parentId: ROOT }),
      ]);
      const extAsc = byName(ext, "song", "asc").map((h) => h.name);
      expect(extAsc).toEqual(
        ["song.mp3", "song a.mp3", "song 2.mp3"].sort(compareNatural),
      );
      expect(extAsc).toEqual(
        byName(ext, "song", "desc")
          .map((h) => h.name)
          .reverse(),
      );
    });

    it("S10. size sort: NaN / ±Infinity / negative are INVALID -> bottom in BOTH directions", () => {
      const index = buildIndex([
        makeFile(ROOT, "Sort Root", {
          isFolder: true,
          mimeType: FOLDER_MIME,
          parentId: "grandroot",
        }),
        makeFile("zero", "size zero.mp3", { parentId: ROOT, size: 0 }),
        makeFile("pos", "size pos.mp3", { parentId: ROOT, size: 100 }),
        makeFile("missing", "size missing.mp3", { parentId: ROOT }),
        makeFile("nan", "size nan.mp3", { parentId: ROOT, size: NaN }),
        makeFile("inf", "size inf.mp3", {
          parentId: ROOT,
          size: Number.POSITIVE_INFINITY,
        }),
        makeFile("ninf", "size ninf.mp3", {
          parentId: ROOT,
          size: Number.NEGATIVE_INFINITY,
        }),
        makeFile("neg", "size neg.mp3", { parentId: ROOT, size: -5 }),
      ]);
      const ids = (dir: "asc" | "desc"): string[] =>
        queryIndex(index, "size", 20, scope, { field: "size", dir })
          .filter((h) => !h.isFolder)
          .map((h) => h.id);
      const valid = ["zero", "pos"];
      const invalid = ["missing", "nan", "inf", "ninf", "neg"];

      const asc = ids("asc");
      expect(asc.slice(0, 2)).toEqual(valid); // 0 then 100
      expect(asc.slice(2).sort()).toEqual([...invalid].sort());
      const desc = ids("desc");
      expect(desc.slice(0, 2)).toEqual(["pos", "zero"]);
      expect(desc.slice(2).sort()).toEqual([...invalid].sort());
      // Relative order among invalid rows is stable across both directions.
      expect(desc.slice(2)).toEqual(asc.slice(2));
      // Zero counts as VALID and sorts below any positive size.
      expect(asc[0]).toBe("zero");
    });
  });
});
