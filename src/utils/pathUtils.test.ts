import { describe, it, expect } from "vitest";
import { basename, stripAudioExtension } from "./pathUtils";

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

describe("stripAudioExtension", () => {
  it("strips a single extension from a plain name", () => {
    expect(stripAudioExtension("song.mp3")).toBe("song");
  });

  it("strips only the final extension of a multi-dot name", () => {
    expect(stripAudioExtension("a.b.mp3")).toBe("a.b");
  });

  it("strips the extension of a dotfile name", () => {
    expect(stripAudioExtension(".mp3")).toBe("");
  });

  it("leaves a folder name without an extension untouched", () => {
    expect(stripAudioExtension("My Folder")).toBe("My Folder");
  });

  it("preserves Vietnamese characters", () => {
    expect(stripAudioExtension("Đổi thay.mp3")).toBe("Đổi thay");
  });

  it("strips the final extension even when the name contains a slash", () => {
    expect(stripAudioExtension("a.b/c.mp3")).toBe("a.b/c");
  });
});
