import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const TB = 1024 * 1024 * 1024 * 1024;

describe("formatBytes", () => {
  it("returns '0 B' for zero, NaN and negative values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(-100)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("keeps sub-1024 values in bytes", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches units at 1024 boundaries", () => {
    expect(formatBytes(KB)).toBe("1 KB");
    expect(formatBytes(MB)).toBe("1 MB");
    expect(formatBytes(1.5 * KB)).toBe("1.5 KB");
  });

  it("formats GB quota values and trims trailing '.0'", () => {
    expect(formatBytes(15 * GB)).toBe("15 GB");
    expect(formatBytes(2.4 * GB)).toBe("2.4 GB");
  });

  it("supports TB scale", () => {
    expect(formatBytes(1.5 * TB)).toBe("1.5 TB");
  });

  it("respects a custom fraction digits argument", () => {
    expect(formatBytes(2.456 * GB, 2)).toBe("2.46 GB");
  });
});
