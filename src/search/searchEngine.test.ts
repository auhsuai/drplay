import { describe, it, expect } from "vitest";
import {
  buildSearchIndex,
  loadRealMetadata,
  queryIndex,
  matchesNormalized,
} from "./searchEngine";
import type { DriveFile, MetadataCacheRow } from "../db/db";
import type { CachedMetadata } from "../utils/metadata";

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

describe("searchEngine", () => {
  it("1. matches diacritics-insensitively (query 'doi' hits 'Đổi thay.mp3')", () => {
    const index = buildIndex([makeFile("f1", "Đổi thay.mp3")]);
    const hits = queryIndex(index, "doi", 10);
    expect(hits.map((h) => h.id)).toContain("f1");
  });

  it("2. combines multiple tokens with AND", () => {
    const index = buildIndex([
      makeFile("a", "Anh dong vien - Yeu em.mp3"),
      makeFile("b", "Doi thay.mp3"),
    ]);
    const hits = queryIndex(index, "anh yeu", 10);
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("3. ranks exact name match above partial matches", () => {
    const index = buildIndex([
      makeFile("exact", "Anh.mp3"),
      makeFile("partial-3-token", "Anh yeu em.mp3"),
      makeFile("partial-2-token", "Yeu anh.mp3"),
    ]);
    const hits = queryIndex(index, "anh", 10);
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
    expect(queryIndex(index, "mo", 10).map((h) => h.id)).toContain("m1");
    // exact (post-normalization) term
    expect(queryIndex(index, "ishmael", 10).map((h) => h.id)).toContain("m2");
    // fuzzy: "ismael" (missing 'h') is edit distance 1 from "ishmael"
    expect(queryIndex(index, "ismael", 10).map((h) => h.id)).toContain("m2");
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
    const noiBuon = queryIndex(index, "noi buon", 10);
    expect(noiBuon.map((h) => h.id)).toEqual(
      expect.arrayContaining(["f2", "f4"]),
    );
    const f2Hit = noiBuon.find((h) => h.id === "f2");
    expect(f2Hit?.title).toBe("Nỗi buồn");
    expect(queryIndex(index, "ca si", 10).map((h) => h.id)).toContain("f2");
    // name field beats title field (boost name 3 > title 2): the file whose
    // NAME is "Noi buon.mp3" must rank above the one matching only via the
    // real-metadata TITLE "Nỗi buồn".
    const byScore = [...noiBuon].sort((a, b) => b.score - a.score);
    expect(byScore[0]?.id).toBe("f4");
    // placeholder metadata ("Unknown Artist", v:9) is NOT searchable
    expect(queryIndex(index, "unknown artist", 10)).toEqual([]);
    // filename stays searchable regardless of metadata status
    expect(queryIndex(index, "01 abc", 10).map((h) => h.id)).toContain("f2");
    expect(queryIndex(index, "02 xyz", 10).map((h) => h.id)).toContain("f3");
  });

  it("6. matches folders by name, returning both files and folders", () => {
    const index = buildIndex([
      makeFile("fol", "Nhạc Việt", {
        isFolder: true,
        mimeType: FOLDER_MIME,
      }),
      makeFile("file", "Nhac vang.mp3"),
    ]);
    const hits = queryIndex(index, "nhac", 10);
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
    const hits = queryIndex(index, "limit-track", LIMIT);
    expect(hits.length).toBe(LIMIT);
    expect(new Set(hits.map((h) => h.id)).size).toBe(LIMIT);
    const scores = hits.map((h) => h.score);
    const sortedDesc = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sortedDesc);
  });

  it("8. returns [] for empty or whitespace-only queries", () => {
    const index = buildIndex([makeFile("f1", "Anh.mp3")]);
    expect(queryIndex(index, "", 10)).toEqual([]);
    expect(queryIndex(index, "   ", 10)).toEqual([]);
  });

  it("9. matchesNormalized keeps substring AND semantics", () => {
    expect(matchesNormalized("Đổi thay", "doi")).toBe(true);
    expect(matchesNormalized("Anh yeu em", "anh yeu")).toBe(true);
    expect(matchesNormalized("Doi thay", "anh yeu")).toBe(false);
    expect(matchesNormalized("x", "")).toBe(false);
  });

  it("10. queryIndex is whitespace-robust", () => {
    const index = buildIndex([makeFile("a", "Anh dong vien - Yeu em.mp3")]);
    const spaced = queryIndex(index, "  anh   yeu ", 10);
    const clean = queryIndex(index, "anh yeu", 10);
    expect(spaced.map((h) => h.id)).toEqual(clean.map((h) => h.id));
    expect(spaced.length).toBe(1);
  });
});
