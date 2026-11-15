import { describe, it, expect } from "vitest";
import { formatDuration } from "./formatDuration";

describe("formatDuration guards + formatting (P2-04-7)", () => {
  it("returns the zero shape for 0, negative, NaN and Infinity inputs", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(-30)).toBe("0:00");
    expect(formatDuration(-1)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
    expect(formatDuration(Infinity)).toBe("0:00");
    expect(formatDuration(-Infinity)).toBe("0:00");
  });

  it("formats durations like the player bar: M:SS under an hour, H:MM:SS above", () => {
    expect(formatDuration(30)).toBe("0:30");
    expect(formatDuration(61)).toBe("1:01");
    expect(formatDuration(204)).toBe("3:24");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(360000)).toBe("100:00:00");
  });
});
