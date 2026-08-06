import { describe, it, expect } from "vitest";
import { normalizeText } from "./normalizeText";

describe("normalizeText", () => {
  it("strips Vietnamese tone marks", () => {
    expect(normalizeText("Nhạc")).toBe("nhac");
    expect(normalizeText("bài hát")).toBe("bai hat");
  });

  it("maps đ/Đ to d", () => {
    expect(normalizeText("Đàn")).toBe("dan");
    expect(normalizeText("đêm")).toBe("dem");
  });

  it("normalizes real Vietnamese words with đ and horned vowels", () => {
    expect(normalizeText("Đổi thay")).toBe("doi thay");
    expect(normalizeText("đường")).toBe("duong");
    expect(normalizeText("Ước mơ")).toBe("uoc mo");
  });

  it("lowercases ascii", () => {
    expect(normalizeText("HELLO World")).toBe("hello world");
  });

  it("keeps emoji and non-latin as-is", () => {
    expect(normalizeText("🎵 song")).toBe("🎵 song");
  });

  it("makes toneless query match toned name via includes", () => {
    expect(normalizeText("Bản nhạc hay").includes(normalizeText("nhac"))).toBe(
      true,
    );
  });
});
