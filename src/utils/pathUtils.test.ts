import { describe, it, expect } from "vitest";
import { basename } from "./pathUtils";

describe("basename", () => {
  it("strips a trailing backslash before taking the last segment", () => {
    expect(basename("C:\\Music\\")).toBe("Music");
  });

  it("strips a trailing forward slash before taking the last segment", () => {
    expect(basename("C:/Music/")).toBe("Music");
  });

  it("returns the path itself when it contains no separator", () => {
    expect(basename("a.mp3")).toBe("a.mp3");
  });

  it("returns the drive letter for a root path", () => {
    // "C:\" trims to "C:" (single part) — pre-existing behavior, kept as-is.
    expect(basename("C:\\")).toBe("C:");
  });

  it("returns an empty string for an empty path", () => {
    expect(basename("")).toBe("");
  });

  it("handles a Windows absolute file path", () => {
    expect(basename("C:\\Music\\a.mp3")).toBe("a.mp3");
  });

  it("handles a forward-slash relative path", () => {
    expect(basename("a/b/c.mp3")).toBe("c.mp3");
  });
});
