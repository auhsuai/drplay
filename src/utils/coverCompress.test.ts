import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  compressCoverVariants,
  isImageTruncated,
  InvalidImageError,
  CoverEncodeError,
  THUMB_MAX_SIZE,
  THUMB_QUALITY,
  FULL_MAX_SIZE,
  FULL_QUALITY,
} from "./coverCompress";

interface CtxStub {
  fillStyle: string;
  imageSmoothingQuality: string;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
}

interface CanvasStub {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  convertToBlob: ReturnType<typeof vi.fn>;
}

interface BitmapStub {
  width: number;
  height: number;
  close: ReturnType<typeof vi.fn>;
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02, 0x03]);

let ctxStubs: CtxStub[] = [];
let canvasStubs: CanvasStub[] = [];
let bitmapStubs: BitmapStub[] = [];

function installCanvasStub(
  opts: {
    failConvert?: boolean;
    failConvertAt?: number;
    blobType?: string;
  } = {},
): void {
  ctxStubs = [];
  canvasStubs = [];
  // 1-based index of the convertToBlob call that should fail (per-variant
  // failure tests). Call order matches canvas creation order because every
  // encode runs synchronously up to its first await.
  let convertCall = 0;
  class MockOffscreenCanvas implements CanvasStub {
    width = 0;
    height = 0;
    getContext = vi.fn(() => {
      const ctx: CtxStub = {
        fillStyle: "",
        imageSmoothingQuality: "",
        fillRect: vi.fn(),
        drawImage: vi.fn(),
      };
      ctxStubs.push(ctx);
      return ctx;
    });
    convertToBlob = vi.fn(() => {
      convertCall += 1;
      if (opts.failConvert || convertCall === opts.failConvertAt)
        return Promise.reject(new Error("convertToBlob failed"));
      return Promise.resolve(
        new Blob([JPEG_BYTES], { type: opts.blobType ?? "image/jpeg" }),
      );
    });
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      canvasStubs.push(this);
    }
  }
  vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
}

function installBitmapStub(width: number, height: number) {
  const createBitmap = vi.fn(() => {
    const bitmap: BitmapStub = { width, height, close: vi.fn() };
    bitmapStubs.push(bitmap);
    return Promise.resolve(bitmap);
  });
  vi.stubGlobal("createImageBitmap", createBitmap);
  return createBitmap;
}

beforeEach(() => {
  ctxStubs = [];
  canvasStubs = [];
  bitmapStubs = [];
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isImageTruncated", () => {
  it("returns false for a complete JPEG (FF D8 magic + FF D9 EOI)", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    expect(isImageTruncated(jpeg)).toBe(false);
  });

  it("returns true for a JPEG cut mid-stream (missing FF D9 EOI)", () => {
    const cut = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    expect(isImageTruncated(cut)).toBe(true);
  });

  it("returns false for a complete PNG (magic + IEND chunk)", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    expect(isImageTruncated(png)).toBe(false);
  });

  it("returns true for a PNG missing the IEND trailer", () => {
    const cut = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5,
    ]);
    expect(isImageTruncated(cut)).toBe(true);
  });

  it("returns false for other formats (no magic match, never cuts)", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    expect(isImageTruncated(gif)).toBe(false);
  });

  it("returns true for data shorter than 8 bytes", () => {
    expect(isImageTruncated(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(true);
  });
});

describe("compressCoverVariants (cover compression)", () => {
  const thumbSpec = { maxSize: THUMB_MAX_SIZE, quality: THUMB_QUALITY };
  const fullSpec = { maxSize: FULL_MAX_SIZE, quality: FULL_QUALITY };
  const input = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

  it("re-encodes a 2500x2500 image down to each variant's maxSize with the right canvas size and JPEG quality", async () => {
    installCanvasStub();
    installBitmapStub(2500, 2500);

    const input = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    const [thumbCanvas, fullCanvas] = canvasStubs;
    expect(thumbCanvas?.width).toBe(256);
    expect(thumbCanvas?.height).toBe(256);
    expect(thumbCanvas?.convertToBlob).toHaveBeenCalledWith({
      type: "image/jpeg",
      quality: 0.7,
    });
    expect(fullCanvas?.width).toBe(2000);
    expect(fullCanvas?.height).toBe(2000);
    expect(fullCanvas?.convertToBlob).toHaveBeenCalledWith({
      type: "image/jpeg",
      quality: 0.8,
    });
    const ctx = ctxStubs[0];
    expect(ctx?.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      256,
      256,
    );

    expect(outcomes).toEqual([
      {
        ok: true,
        result: { data: JPEG_BYTES, format: "image/jpeg", keptOriginal: false },
      },
      {
        ok: true,
        result: { data: JPEG_BYTES, format: "image/jpeg", keptOriginal: false },
      },
    ]);
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the original bytes when the image already fits (no re-encode, no upscale)", async () => {
    installCanvasStub();
    installBitmapStub(200, 200);
    const input = new Uint8Array([0xff, 0xd8, 7, 8, 9, 0xff, 0xd9]);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    expect(outcomes[0]).toEqual({
      ok: true,
      result: { data: input, format: "image/jpeg", keptOriginal: true },
    });
    expect(outcomes[1]).toEqual({
      ok: true,
      result: { data: input, format: "image/jpeg", keptOriginal: true },
    });
    expect(canvasStubs.length).toBe(0);
    expect(ctxStubs.length).toBe(0);
  });

  it("keeps the original full bytes at the 2000px boundary (no re-encode, no upscale)", async () => {
    installCanvasStub();
    installBitmapStub(2000, 2000);
    const input = new Uint8Array([0xff, 0xd8, 7, 8, 9, 0xff, 0xd9]);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      fullSpec,
    ]);

    expect(outcomes[0]).toEqual({
      ok: true,
      result: { data: input, format: "image/jpeg", keptOriginal: true },
    });
    expect(canvasStubs.length).toBe(0);
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("re-encodes the thumb but keeps the original for the full variant (800x800)", async () => {
    installCanvasStub();
    installBitmapStub(800, 800);
    const input = new Uint8Array([0xff, 0xd8, 1, 1, 1, 0xff, 0xd9]);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    expect(outcomes[0]).toEqual({
      ok: true,
      result: { data: JPEG_BYTES, format: "image/jpeg", keptOriginal: false },
    });
    expect(canvasStubs[0]?.width).toBe(256);
    expect(outcomes[1]).toEqual({
      ok: true,
      result: { data: input, format: "image/jpeg", keptOriginal: true },
    });
    expect(canvasStubs.length).toBe(1);
  });

  it("throws InvalidImageError when decode fails", async () => {
    installCanvasStub();
    installBitmapStub(0, 0);
    vi.mocked(
      globalThis.createImageBitmap as ReturnType<typeof vi.fn>,
    ).mockRejectedValueOnce(new Error("Image decode error"));

    await expect(
      compressCoverVariants(new Uint8Array([1, 2, 3]), "image/jpeg", [
        thumbSpec,
      ]),
    ).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("fills the canvas white before drawing when the source format has alpha (PNG)", async () => {
    installCanvasStub();
    installBitmapStub(500, 500);

    await compressCoverVariants(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      "image/png",
      [thumbSpec],
    );

    const ctx = ctxStubs[0];
    expect(ctx?.fillStyle).toBe("#ffffff");
    expect(ctx?.fillRect).toHaveBeenCalledWith(0, 0, 256, 256);
    const fillOrder = ctx?.fillRect.mock.invocationCallOrder[0] ?? 0;
    const drawOrder = ctx?.drawImage.mock.invocationCallOrder[0] ?? 0;
    expect(fillOrder).toBeLessThan(drawOrder);
  });

  it("sets high-quality image smoothing before drawing (quality downscale)", async () => {
    installCanvasStub();
    installBitmapStub(2000, 2000);

    await compressCoverVariants(
      new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]),
      "image/jpeg",
      [thumbSpec],
    );

    const ctx = ctxStubs[0];
    expect(ctx?.imageSmoothingQuality).toBe("high");
  });

  it("reports CoverEncodeError when the canvas blob conversion fails", async () => {
    installCanvasStub({ failConvert: true });
    installBitmapStub(2000, 2000);

    const outcomes = await compressCoverVariants(
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
      [thumbSpec],
    );

    expect(outcomes[0]).toEqual({
      ok: false,
      error: expect.any(CoverEncodeError) as CoverEncodeError,
    });
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("fails loud when convertToBlob falls back to a non-JPEG blob (no silent PNG-as-JPEG)", async () => {
    installCanvasStub({ blobType: "image/png" });
    installBitmapStub(2500, 2500);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
    ]);

    expect(outcomes[0]).toEqual({
      ok: false,
      error: expect.any(CoverEncodeError) as CoverEncodeError,
    });
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });
});

describe("compressCoverVariants (one decode, many variants)", () => {
  const thumbSpec = { maxSize: THUMB_MAX_SIZE, quality: THUMB_QUALITY };
  const fullSpec = { maxSize: FULL_MAX_SIZE, quality: FULL_QUALITY };
  const input = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

  it("decodes once and re-encodes both variants from the shared bitmap (2500x2500)", async () => {
    installCanvasStub();
    const createBitmap = installBitmapStub(2500, 2500);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    expect(createBitmap).toHaveBeenCalledTimes(1);
    const [thumbCanvas, fullCanvas] = canvasStubs;
    expect(thumbCanvas?.width).toBe(THUMB_MAX_SIZE);
    expect(thumbCanvas?.height).toBe(THUMB_MAX_SIZE);
    expect(fullCanvas?.width).toBe(FULL_MAX_SIZE);
    expect(fullCanvas?.height).toBe(FULL_MAX_SIZE);
    expect(thumbCanvas?.convertToBlob).toHaveBeenCalledWith({
      type: "image/jpeg",
      quality: THUMB_QUALITY,
    });
    expect(fullCanvas?.convertToBlob).toHaveBeenCalledWith({
      type: "image/jpeg",
      quality: FULL_QUALITY,
    });
    expect(outcomes).toEqual([
      {
        ok: true,
        result: { data: JPEG_BYTES, format: "image/jpeg", keptOriginal: false },
      },
      {
        ok: true,
        result: { data: JPEG_BYTES, format: "image/jpeg", keptOriginal: false },
      },
    ]);
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("keeps both originals for a small image but still decodes once (200x200)", async () => {
    installCanvasStub();
    const createBitmap = installBitmapStub(200, 200);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    // Still one decode — dimensions are only known after decoding.
    expect(createBitmap).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      {
        ok: true,
        result: { data: input, format: "image/jpeg", keptOriginal: true },
      },
      {
        ok: true,
        result: { data: input, format: "image/jpeg", keptOriginal: true },
      },
    ]);
    expect(canvasStubs.length).toBe(0);
    expect(ctxStubs.length).toBe(0);
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("re-encodes the thumb but keeps the original full bytes at mid size (800x800)", async () => {
    installCanvasStub();
    installBitmapStub(800, 800);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    expect(outcomes[0]).toEqual({
      ok: true,
      result: { data: JPEG_BYTES, format: "image/jpeg", keptOriginal: false },
    });
    expect(outcomes[1]).toEqual({
      ok: true,
      result: { data: input, format: "image/jpeg", keptOriginal: true },
    });
    expect(canvasStubs.length).toBe(1);
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the full variant when the thumb encode fails (per-variant isolation)", async () => {
    installCanvasStub({ failConvertAt: 1 });
    installBitmapStub(2500, 2500);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    expect(outcomes[0]).toEqual({
      ok: false,
      error: expect.any(CoverEncodeError) as CoverEncodeError,
    });
    expect(outcomes[1]).toEqual({
      ok: true,
      result: { data: JPEG_BYTES, format: "image/jpeg", keptOriginal: false },
    });
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the thumb variant when the full encode fails", async () => {
    installCanvasStub({ failConvertAt: 2 });
    installBitmapStub(2500, 2500);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    expect(outcomes[0]).toEqual({
      ok: true,
      result: { data: JPEG_BYTES, format: "image/jpeg", keptOriginal: false },
    });
    expect(outcomes[1]).toEqual({
      ok: false,
      error: expect.any(CoverEncodeError) as CoverEncodeError,
    });
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("throws InvalidImageError on decode failure without leaking a bitmap", async () => {
    installCanvasStub();
    const createBitmap = installBitmapStub(0, 0);
    vi.mocked(
      globalThis.createImageBitmap as ReturnType<typeof vi.fn>,
    ).mockRejectedValueOnce(new Error("Image decode error"));

    await expect(
      compressCoverVariants(input, "image/jpeg", [thumbSpec, fullSpec]),
    ).rejects.toBeInstanceOf(InvalidImageError);
    expect(createBitmap).toHaveBeenCalledTimes(1);
    expect(bitmapStubs.length).toBe(0);
  });

  it("closes the bitmap exactly once even when every variant fails", async () => {
    installCanvasStub({ failConvert: true });
    installBitmapStub(2500, 2500);

    const outcomes = await compressCoverVariants(input, "image/jpeg", [
      thumbSpec,
      fullSpec,
    ]);

    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[1]?.ok).toBe(false);
    expect(bitmapStubs[0]?.close).toHaveBeenCalledTimes(1);
  });
});
