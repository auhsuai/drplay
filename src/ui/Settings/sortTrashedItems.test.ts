import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRASH_SORT_DIRECTION,
  sortTrashedItems,
} from "./sortTrashedItems";

// Local structural mirror of TrashedItem — the comparator only reads these
// fields; TrashScreen passes TrashedItem[] straight through.
interface Item {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  deletedAt?: string;
  trashedTime?: string;
  modifiedTime?: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

const file = (id: string, name: string, extra: Partial<Item> = {}): Item => ({
  id,
  name,
  mimeType: "audio/mpeg",
  ...extra,
});

const folder = (id: string, name: string, extra: Partial<Item> = {}): Item => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  ...extra,
});

const ids = (items: Item[]): string[] => items.map((item) => item.id);

describe("sortTrashedItems", () => {
  it("sorts names with a natural, case-insensitive, numeric-aware collator", () => {
    const items = [
      file("a", "Track 10.mp3"),
      file("b", "track 2.mp3"),
      file("c", "Alpha.mp3"),
    ];
    const sorted = sortTrashedItems(items, "name", "asc");
    expect(ids(sorted)).toEqual(["c", "b", "a"]);
  });

  it("sorts names descending on the same collator", () => {
    const items = [file("a", "Alpha.mp3"), file("b", "Zed.mp3")];
    expect(ids(sortTrashedItems(items, "name", "desc"))).toEqual(["b", "a"]);
  });

  it("keeps the original order for equal names (stable tie-break)", () => {
    const items = [file("first", "Same.mp3"), file("second", "same.MP3")];
    expect(ids(sortTrashedItems(items, "name", "asc"))).toEqual([
      "first",
      "second",
    ]);
    expect(ids(sortTrashedItems(items, "name", "desc"))).toEqual([
      "first",
      "second",
    ]);
  });

  it("sorts deletedAt numerically ascending and descending", () => {
    const items = [
      file("new", "New.mp3", { deletedAt: "2026-03-01T00:00:00.000Z" }),
      file("old", "Old.mp3", { deletedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(ids(sortTrashedItems(items, "deletedAt", "asc"))).toEqual([
      "old",
      "new",
    ]);
    expect(ids(sortTrashedItems(items, "deletedAt", "desc"))).toEqual([
      "new",
      "old",
    ]);
  });

  it("sorts on the same effective date the rows display (deletedAt ?? trashedTime ?? modifiedTime)", () => {
    const items = [
      file("trashed", "Trashed.mp3", {
        trashedTime: "2026-05-01T00:00:00.000Z",
      }),
      file("modified", "Modified.mp3", {
        modifiedTime: "2026-01-01T00:00:00.000Z",
      }),
    ];
    // Ascending: the January modifiedTime row sorts before the May
    // trashedTime row — the sort key must match the displayed value.
    expect(ids(sortTrashedItems(items, "deletedAt", "asc"))).toEqual([
      "modified",
      "trashed",
    ]);
  });

  it("sends missing dates to the end in BOTH directions", () => {
    const dated = file("d", "Dated.mp3", {
      deletedAt: "2026-02-01T00:00:00.000Z",
    });
    const missing = file("m", "Missing.mp3");
    const malformed = file("x", "Malformed.mp3", {
      modifiedTime: "not-a-date",
    });
    expect(
      ids(sortTrashedItems([missing, malformed, dated], "deletedAt", "asc")),
    ).toEqual(["d", "x", "m"]);
    expect(
      ids(sortTrashedItems([missing, malformed, dated], "deletedAt", "desc")),
    ).toEqual(["d", "x", "m"]);
  });

  it("compares sizes numerically, never as formatted strings", () => {
    const items = [
      file("big", "Big.mp3", { size: "1000" }),
      file("small", "Small.mp3", { size: "999" }),
    ];
    expect(ids(sortTrashedItems(items, "size", "asc"))).toEqual([
      "small",
      "big",
    ]);
    expect(ids(sortTrashedItems(items, "size", "desc"))).toEqual([
      "big",
      "small",
    ]);
  });

  it("sends missing/malformed sizes (folders, non-numeric) to the end in BOTH directions", () => {
    const sized = file("s", "Sized.mp3", { size: "10" });
    const noSize = file("n", "NoSize.mp3");
    const malformed = file("x", "Malformed.mp3", { size: "abc" });
    expect(
      ids(sortTrashedItems([noSize, malformed, sized], "size", "asc")),
    ).toEqual(["s", "x", "n"]);
    expect(
      ids(sortTrashedItems([noSize, malformed, sized], "size", "desc")),
    ).toEqual(["s", "x", "n"]);
  });

  it("tie-breaks equal dates and sizes by the name collator", () => {
    const items = [
      file("z", "Zed.mp3", {
        size: "10",
        deletedAt: "2026-02-01T00:00:00.000Z",
      }),
      file("a", "Alpha.mp3", {
        size: "10",
        deletedAt: "2026-02-01T00:00:00.000Z",
      }),
    ];
    expect(ids(sortTrashedItems(items, "size", "asc"))).toEqual(["a", "z"]);
    expect(ids(sortTrashedItems(items, "deletedAt", "desc"))).toEqual([
      "a",
      "z",
    ]);
  });

  it("keeps folders before files for every key and direction", () => {
    const items = [
      file("file", "A.mp3", {
        size: "999",
        deletedAt: "2026-01-01T00:00:00.000Z",
      }),
      folder("fold", "Z Folder"),
    ];
    for (const key of ["name", "deletedAt", "size"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        expect(ids(sortTrashedItems(items, key, direction))).toEqual([
          "fold",
          "file",
        ]);
      }
    }
  });

  it("sorts folders among themselves by the chosen key", () => {
    const items = [folder("z", "Zeta"), folder("a", "Alpha")];
    expect(ids(sortTrashedItems(items, "name", "asc"))).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const items = [file("b", "Zed.mp3"), file("a", "Alpha.mp3")];
    const snapshot = [...items];
    sortTrashedItems(items, "name", "asc");
    expect(items).toEqual(snapshot);
  });

  it("applies the Google-Drive default direction per column", () => {
    expect(DEFAULT_TRASH_SORT_DIRECTION).toEqual({
      name: "asc",
      deletedAt: "desc",
      size: "desc",
    });
  });
});
