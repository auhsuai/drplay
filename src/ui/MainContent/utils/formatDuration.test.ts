import { describe, it, expect } from "vitest";
import { formatDuration } from "./formatDuration";

describe("formatDuration guards + formatting (P2-04-7)", () => {
  it("returns the zero shape for 0, negative, NaN and Infinity inputs", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(-30)).toBe("00:00:00");
    expect(formatDuration(-1)).toBe("00:00:00");
    expect(formatDuration(NaN)).toBe("00:00:00");
    expect(formatDuration(Infinity)).toBe("00:00:00");
    expect(formatDuration(-Infinity)).toBe("00:00:00");
  });

  it("formats normal durations as HH:MM:SS", () => {
    expect(formatDuration(30)).toBe("00:00:30");
    expect(formatDuration(61)).toBe("00:01:01");
    expect(formatDuration(3661)).toBe("01:01:01");
    expect(formatDuration(360000)).toBe("100:00:00");
  });
});
