import { describe, it, expect, vi } from "vitest";
import { truncatePathMiddle } from "./truncatePath";

// Lone surrogates render as U+FFFD in the WebView: any truncation must only
// cut between whole grapheme clusters, never inside one.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function graphemeCount(value: string): number {
  // tsconfig lib is ES2020: no Intl.Segmenter types, so use a structural cast.
  const intlRef = globalThis as unknown as {
    Intl?: {
      Segmenter?: new (
        locales?: string,
        options?: { granularity?: string },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    };
  };
  const Ctor = intlRef.Intl?.Segmenter;
  if (typeof Ctor !== "function") return value.length;
  return [...new Ctor(undefined, { granularity: "grapheme" }).segment(value)]
    .length;
}

describe("truncatePathMiddle", () => {
  it("returns short paths unchanged without ellipsis", () => {
    expect(truncatePathMiddle("C:\\Music")).toBe("C:\\Music");
    expect(truncatePathMiddle("C:\\Users\\thinkpad\\Music")).toBe(
      "C:\\Users\\thinkpad\\Music",
    );
    expect(truncatePathMiddle("C:\\Users\\thinkpad\\Music")).not.toContain("…");
  });

  it("keeps the first segment pair and the full last segment for long windows paths", () => {
    const long = "C:\\Users\\thinkpad\\Desktop\\Antigravity\\drplay\\Music";
    expect(truncatePathMiddle(long)).toBe("C:\\Users\\…\\Music");
  });

  it("keeps the final segment intact when truncating", () => {
    const long =
      "C:\\Users\\thinkpad\\Desktop\\Antigravity\\drplay\\MyMusicFolder";
    const result = truncatePathMiddle(long);
    expect(result).toContain("…");
    expect(result.startsWith("C:\\Users")).toBe(true);
    expect(result.endsWith("MyMusicFolder")).toBe(true);
  });

  it("never strips the only segment of a single-segment path", () => {
    const single = "MyVeryLongSingleSegmentFolderName123456789";
    expect(truncatePathMiddle(single)).toBe(single);
  });

  it("leaves a bare drive path like C:\\ untouched", () => {
    expect(truncatePathMiddle("C:\\")).toBe("C:\\");
  });

  it("handles mixed separators (both \\ and /)", () => {
    const mixed = "D:\\data\\music/albums\\MyVeryLongDestinationFolder";
    expect(truncatePathMiddle(mixed)).toBe(
      "D:\\data\\…\\MyVeryLongDestinationFolder",
    );
  });

  it("uses the actual separator of the path", () => {
    const posixFirst = "D:/data/music/albums/MyVeryLongDestinationFolder";
    expect(truncatePathMiddle(posixFirst)).toBe(
      "D:/data/…/MyVeryLongDestinationFolder",
    );
  });

  it("handles UNC paths", () => {
    const unc = "\\\\server\\share\\Music\\albums\\MyMusicFolders";
    expect(truncatePathMiddle(unc)).toBe(
      "\\\\server\\share\\…\\MyMusicFolders",
    );
  });

  it("never exceeds the max chars budget even with a huge last segment", () => {
    const longSuffix = "C:\\Users\\a\\" + "X".repeat(60);
    const result = truncatePathMiddle(longSuffix);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.startsWith("C:\\Users")).toBe(true);
    expect(result.endsWith("X".repeat(29))).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(truncatePathMiddle("")).toBe("");
  });

  it("defensively handles non-string input", () => {
    expect(truncatePathMiddle(undefined as unknown as string)).toBe("");
    expect(truncatePathMiddle(null as unknown as string)).toBe("");
  });

  it("never splits a ZWJ emoji sequence when clipping the suffix", () => {
    const family = "👨‍👩‍👧‍👦"; // 1 grapheme, 11 UTF-16 units
    const long = "C:\\Users\\a\\" + family.repeat(10);
    const result = truncatePathMiddle(long);
    expect(result).not.toMatch(LONE_SURROGATE);
    // The clipped suffix must end on a grapheme boundary (old UTF-16
    // slicing left a partial third sequence here).
    expect(result.endsWith(family.repeat(2))).toBe(true);
    expect(graphemeCount(result)).toBeLessThanOrEqual(40);
  });

  it("never splits combining marks when clipping the suffix", () => {
    const eAcute = "é"; // e + combining acute: 1 grapheme, 2 UTF-16 units
    const long = "C:\\Users\\a\\" + eAcute.repeat(30);
    const result = truncatePathMiddle(long);
    expect(result).not.toMatch(LONE_SURROGATE);
    expect(graphemeCount(result)).toBeLessThanOrEqual(40);
    // The whole 29-grapheme budget goes to complete e+acute pairs (old
    // UTF-16 slicing kept 14 pairs plus a stripped trailing "e").
    expect(result.endsWith(eAcute.repeat(29))).toBe(true);
  });

  it("falls back to legacy slicing when Intl.Segmenter is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("Intl", { Segmenter: undefined });
    let fresh: typeof import("./truncatePath");
    try {
      fresh = await import("./truncatePath");
    } finally {
      vi.unstubAllGlobals();
    }
    const ascii = "C:\\Users\\thinkpad\\Desktop\\Antigravity\\drplay\\Music";
    expect(fresh.truncatePathMiddle(ascii)).toBe("C:\\Users\\…\\Music");
    expect(fresh.truncatePathMiddle("C:\\Music")).toBe("C:\\Music");
    vi.resetModules();
  });
});
