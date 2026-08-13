// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import type { DriveItem } from "../types";
import { sortDriveItems } from "./useDriveListing";

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
