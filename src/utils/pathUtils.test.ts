import { describe, it, expect } from "vitest";
import { stripAudioExtension } from "./pathUtils";

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
