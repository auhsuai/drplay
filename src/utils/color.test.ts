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
import { captureError } from "./errorLog";
import { getPalette } from "./color";

vi.mock("./errorLog", () => ({
  captureError: vi.fn().mockResolvedValue(undefined)
}));

const mockedCaptureError = vi.mocked(captureError);

// Minimal canvas/Image stubs so the decode path executes without a real DOM.
// NOTE: under Vitest 4 a `vi.fn().mockImplementation(() => ({}))` is no longer
// constructable via `new`, so we use a real class and track instances on the
// constructor to preserve the call-count assertions below.
function installImageStubs() {
  const ctor = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    crossOrigin: string | null = null;
    constructor() {
      (ctor as any).instances.push(this);
      // Resolve asynchronously like a real network image load.
      queueMicrotask(() => {
        if (typeof this.onload === "function") this.onload();
      });
    }
    set src(_v: string) {
      /* triggering onload via microtask above */
    }
    get src() {
      return "";
    }
  };
  (ctor as any).instances = [] as any[];
  (ctor as any).mockClear = () => {
    (ctor as any).instances = [] as any[];
  };
  (globalThis as any).Image = ctor;

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
  return ctor;
}

describe("getPalette — memoization (P0-2 regression)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the same array reference and does not re-decode on repeat calls", async () => {
    const ImageCtor = installImageStubs() as any;

    const url = "http://drplay.localhost/cover?id=abc&thumb=true&v=2";
    const first = await getPalette(url);
    const second = await getPalette(url);

    expect(Array.isArray(first)).toBe(true);
    expect(first.length).toBe(4);
    // Memo hit: identical reference, no second decode.
    expect(second).toBe(first);
    // Image must be constructed at most once across both calls.
    expect(ImageCtor.instances.length).toBe(1);
  });

  it("distinct URLs are decoded independently", async () => {
    const ImageCtor = installImageStubs() as any;

    const a = await getPalette("http://x/cover?id=1&thumb=true");
    const b = await getPalette("http://x/cover?id=2&thumb=true");

    expect(a).not.toBe(b);
    expect(ImageCtor.instances.length).toBe(2);
  });

  it("rejects with 'Image load error' and logs via captureError when the image fails to load", async () => {
    const ctor = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin: string | null = null;
      constructor() {
        // Resolve asynchronously like a real network image failure.
        queueMicrotask(() => {
          if (typeof this.onerror === "function") this.onerror();
        });
      }
      set src(_v: string) {
        /* error fired via microtask above */
      }
      get src() {
        return "";
      }
    };
    (globalThis as any).Image = ctor;

    await expect(getPalette("http://x/broken-cover")).rejects.toThrow("Image load error");
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "color",
      message: "getPalette image load failed"
    });
  });
});
