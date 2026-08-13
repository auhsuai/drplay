import { describe, expect, it } from "vitest";
import {
  classifyPlayerError,
  isAbortError,
  seekRelative,
  SEEK_STEP_SECONDS,
} from "./utils";

describe("isAbortError (duck-typed)", () => {
  it("true cho DOMException AbortError thật", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
  });

  it('true cho object duck-typed { name: "AbortError" } không phải DOMException (jsdom)', () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it("false cho DOMException khác tên", () => {
    expect(
      isAbortError(new DOMException("NotAllowed", "NotAllowedError")),
    ).toBe(false);
  });

  it("false cho Error thường, string, null, undefined", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it("classifyPlayerError vẫn hoạt động như cũ", () => {
    expect(classifyPlayerError(new Error("x")).name).toBe("Error");
    expect(classifyPlayerError("x").message).toBe("x");
    expect(classifyPlayerError(42).name).toBe("UnknownError");
  });
});

describe("seekRelative (chung cho keyboard seek + media session)", () => {
  function makeAudio(
    overrides: { currentTime?: number; duration?: number } = {},
  ) {
    const audio = {
      currentTime: overrides.currentTime ?? 0,
      duration: overrides.duration ?? 0,
      seekCalls: [] as number[],
      seek(time: number) {
        audio.seekCalls.push(time);
      },
      getCurrentTime() {
        return audio.currentTime;
      },
      getDuration() {
        return audio.duration;
      },
    };
    return audio;
  }

  it("duration 0 (chưa load metadata) → KHÔNG seek (giữ vị trí, không seek về 0)", () => {
    const audio = makeAudio({ currentTime: 30, duration: 0 });
    seekRelative(audio, SEEK_STEP_SECONDS);
    expect(audio.seekCalls).toEqual([]);
  });

  it("seek forward: clamp tại duration", () => {
    const audio = makeAudio({ currentTime: 118, duration: 120 });
    seekRelative(audio, SEEK_STEP_SECONDS);
    expect(audio.seekCalls).toEqual([120]);
  });

  it("seek backward: clamp tại 0", () => {
    const audio = makeAudio({ currentTime: 2, duration: 120 });
    seekRelative(audio, -SEEK_STEP_SECONDS);
    expect(audio.seekCalls).toEqual([0]);
  });

  it("seek trong phạm vi: cộng delta chính xác", () => {
    const audio = makeAudio({ currentTime: 30, duration: 120 });
    seekRelative(audio, SEEK_STEP_SECONDS);
    expect(audio.seekCalls).toEqual([35]);
  });

  it("SEEK_STEP_SECONDS là 1 nguồn chung (5s)", () => {
    expect(SEEK_STEP_SECONDS).toBe(5);
  });
});
