// Regression test for P0-2: getPalette used to decode + run 4 quadrant
// getImageData loops on EVERY cover load (every track switch / auto-advance),
// always on the FULL (often multi-MB) cover URL, with NO memoization — burning
// CPU on the main thread and causing jank.
//
// This test calls getPalette twice with the same URL and asserts the second
// call is a pure cache hit: it returns the SAME array reference and does NOT
// construct a second Image / re-decode the picture. On the old (un-memoized)
// code the second call builds a fresh Image and decodes again, so the test
// fails; after the memo fix it passes.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPalette } from "./color";

// Minimal canvas/Image stubs so the decode path executes without a real DOM.
function installImageStubs() {
  const imageCtor = vi.fn().mockImplementation(() => {
    const img: any = {};
    // Resolve asynchronously like a real network image load.
    queueMicrotask(() => {
      if (typeof img.onload === "function") img.onload();
    });
    Object.defineProperty(img, "src", {
      set() {
        /* triggering onload via microtask above */
      },
      get() {
        return "";
      },
    });
    return img;
  });
  (globalThis as any).Image = imageCtor;

  (globalThis as any).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }),
      }),
    }),
  };
  return imageCtor;
}

describe("getPalette — memoization (P0-2 regression)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the same array reference and does not re-decode on repeat calls", async () => {
    const ImageCtor = installImageStubs();

    const url = "http://drplay.localhost/cover?id=abc&thumb=true&v=2";
    const first = await getPalette(url);
    const second = await getPalette(url);

    expect(Array.isArray(first)).toBe(true);
    expect(first.length).toBe(4);
    // Memo hit: identical reference, no second decode.
    expect(second).toBe(first);
    // Image must be constructed at most once across both calls.
    expect(ImageCtor).toHaveBeenCalledTimes(1);
  });

  it("distinct URLs are decoded independently", async () => {
    const ImageCtor = installImageStubs();

    const a = await getPalette("http://x/cover?id=1&thumb=true");
    const b = await getPalette("http://x/cover?id=2&thumb=true");

    expect(a).not.toBe(b);
    expect(ImageCtor).toHaveBeenCalledTimes(2);
  });
});
