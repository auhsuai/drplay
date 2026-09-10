// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberTotalSizesInServiceWorker } from "./swPrefetch";

// Page-side wire test: the util must mirror prefetchTrackInServiceWorker's
// contract — no controlling worker (SW not yet active / non-secure context)
// is a silent no-op, everything else posts one message the SW's message
// handler understands.

function stubController(controller: unknown): void {
  Object.defineProperty(navigator, "serviceWorker", {
    value: { controller },
    configurable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("rememberTotalSizesInServiceWorker (page → SW wire)", () => {
  it("posts a REMEMBER_TOTAL_SIZES message with the entries payload", () => {
    const postMessage = vi.fn();
    stubController({ postMessage });
    const entries = [
      { fileId: "f1", size: 300 },
      { fileId: "f2", size: 12_345 },
    ];
    rememberTotalSizesInServiceWorker(entries);
    expect(postMessage).toHaveBeenCalledWith({
      type: "REMEMBER_TOTAL_SIZES",
      entries,
    });
  });

  it("is a silent no-op without a controlling service worker", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubController(null);
    expect(() => {
      rememberTotalSizesInServiceWorker([{ fileId: "f1", size: 300 }]);
    }).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns early for empty entries without touching the controller", () => {
    const postMessage = vi.fn();
    stubController({ postMessage });
    rememberTotalSizesInServiceWorker([]);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
