import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { emitPlayerUi, onPlayerUi } from "./playerUiBus";
import { captureError } from "../utils/errorLog";

describe("playerUiBus", () => {
  it("delivers a media-info event to every subscriber", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onPlayerUi(first);
    const offSecond = onPlayerUi(second);

    try {
      emitPlayerUi("media-info");

      expect(first).toHaveBeenCalledWith({ kind: "media-info" });
      expect(second).toHaveBeenCalledWith({ kind: "media-info" });
    } finally {
      offFirst();
      offSecond();
    }
  });

  it("delivers a toast payload", () => {
    const handler = vi.fn();
    const off = onPlayerUi(handler);
    try {
      emitPlayerUi("toast", { variant: "success", message: "done" });
      expect(handler).toHaveBeenCalledWith({
        kind: "toast",
        payload: { variant: "success", message: "done" },
      });
    } finally {
      off();
    }
  });

  it("stops delivering after unsubscribe", () => {
    const handler = vi.fn();
    const off = onPlayerUi(handler);
    off();

    emitPlayerUi("media-info");
    expect(handler).not.toHaveBeenCalled();
  });

  it("isolates a throwing subscriber and logs it with context", () => {
    const bad = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const good = vi.fn();
    const offBad = onPlayerUi(bad);
    const offGood = onPlayerUi(good);
    vi.mocked(captureError).mockClear();

    try {
      emitPlayerUi("media-info");

      expect(good).toHaveBeenCalledTimes(1);
      expect(captureError).toHaveBeenCalledTimes(1);
      const logged = vi.mocked(captureError).mock.calls[0]?.[0] as {
        source: string;
        message: string;
      };
      expect(logged.source).toBe("playerUiBus");
      expect(logged.message).toContain("subscriber blew up");
    } finally {
      offBad();
      offGood();
    }
  });
});
