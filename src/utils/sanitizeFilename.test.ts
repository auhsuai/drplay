import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "./sanitizeFilename";

describe("sanitizeFilename", () => {
  it("replaces characters Windows forbids in file names", () => {
    expect(sanitizeFilename("A/B:C*")).toBe("A_B_C_");
    expect(sanitizeFilename('D?E|F"G<H>I\\J')).toBe("D_E_F_G_H_I_J");
  });

  it("guards DOS device names", () => {
    expect(sanitizeFilename("CON")).toBe("_CON");
    expect(sanitizeFilename("con.mp3")).toBe("_con.mp3");
    expect(sanitizeFilename("COM1")).toBe("_COM1");
    expect(sanitizeFilename("LPT9.txt")).toBe("_LPT9.txt");
    expect(sanitizeFilename("concert.mp3")).toBe("concert.mp3");
  });

  it("trims trailing dots and spaces", () => {
    expect(sanitizeFilename("song. ")).toBe("song");
    expect(sanitizeFilename("song...")).toBe("song");
  });

  it("caps the name at 255 characters", () => {
    expect(sanitizeFilename("a".repeat(300))).toBe("a".repeat(255));
  });

  it("falls back when nothing usable remains", () => {
    expect(sanitizeFilename("   ", "Untitled")).toBe("Untitled");
    expect(sanitizeFilename("", "Untitled")).toBe("Untitled");
    expect(sanitizeFilename("///")).toBe("___");
  });

  it("leaves an ordinary name untouched", () => {
    expect(sanitizeFilename("Test Song - Test Artist.mp3")).toBe(
      "Test Song - Test Artist.mp3",
    );
  });
});
