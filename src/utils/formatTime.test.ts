import { describe, expect, it } from "vitest";
import { formatTime } from "./formatTime";

describe("formatTime", () => {
  it("formats 0 seconds as 0:00", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  it("formats sub-minute values as m:ss", () => {
    expect(formatTime(59)).toBe("0:59");
  });

  it("rolls over to whole minutes at 60", () => {
    expect(formatTime(60)).toBe("1:00");
  });

  it("formats just under an hour as m:ss", () => {
    expect(formatTime(3599)).toBe("59:59");
  });

  it("rolls over to h:mm:ss at 3600", () => {
    expect(formatTime(3600)).toBe("1:00:00");
  });

  it("pads hour, minute and second fields", () => {
    expect(formatTime(36000)).toBe("10:00:00");
  });

  it("handles 24 hours without wrapping", () => {
    expect(formatTime(86400)).toBe("24:00:00");
  });

  it("truncates non-integer seconds (floors)", () => {
    expect(formatTime(90.5)).toBe("1:30");
  });

  it("returns 0:00 for NaN", () => {
    expect(formatTime(NaN)).toBe("0:00");
  });

  it("returns 0:00 for negative values", () => {
    expect(formatTime(-1)).toBe("0:00");
  });

  it("returns 0:00 for Infinity", () => {
    expect(formatTime(Infinity)).toBe("0:00");
  });
});
