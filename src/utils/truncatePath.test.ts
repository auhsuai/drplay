import { describe, it, expect } from "vitest";
import { truncatePathMiddle } from "./truncatePath";

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
});
