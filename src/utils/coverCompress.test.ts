import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  compressCoverImage,
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

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02, 0x03]);

let ctxStubs: CtxStub[] = [];
let canvasStubs: CanvasStub[] = [];

function installCanvasStub(opts: { failConvert?: boolean } = {}): void {
  ctxStubs = [];
  canvasStubs = [];
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
      if (opts.failConvert)
        return Promise.reject(new Error("convertToBlob failed"));
      return Promise.resolve(new Blob([JPEG_BYTES], { type: "image/jpeg" }));
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
  const bitmap = vi.fn(() => Promise.resolve({ width, height }));
  vi.stubGlobal("createImageBitmap", bitmap);
  return bitmap;
}

beforeEach(() => {
  ctxStubs = [];
  canvasStubs = [];
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

describe("compressCoverImage", () => {
  it("re-encodes a 2000x2000 image down to maxSize with the right canvas size and JPEG quality", async () => {
    installCanvasStub();
    installBitmapStub(2000, 2000);

    const input = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const thumb = await compressCoverImage(
      input,
      "image/jpeg",
      THUMB_MAX_SIZE,
      THUMB_QUALITY,
    );
    await compressCoverImage(input, "image/jpeg", FULL_MAX_SIZE, FULL_QUALITY);

    const [thumbCanvas, fullCanvas] = canvasStubs;
    expect(thumbCanvas?.width).toBe(256);
    expect(thumbCanvas?.height).toBe(256);
    expect(thumbCanvas?.convertToBlob).toHaveBeenCalledWith({
      type: "image/jpeg",
      quality: 0.7,
    });
    expect(fullCanvas?.width).toBe(1000);
    expect(fullCanvas?.height).toBe(1000);
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

    expect(thumb.data).toEqual(JPEG_BYTES);
    expect(thumb.format).toBe("image/jpeg");
    expect(thumb.keptOriginal).toBe(false);
  });

  it("keeps the original bytes when the image already fits (no re-encode, no upscale)", async () => {
    installCanvasStub();
    installBitmapStub(200, 200);
    const input = new Uint8Array([0xff, 0xd8, 7, 8, 9, 0xff, 0xd9]);

    const thumb = await compressCoverImage(
      input,
      "image/jpeg",
      THUMB_MAX_SIZE,
      THUMB_QUALITY,
    );
    const full = await compressCoverImage(
      input,
      "image/jpeg",
      FULL_MAX_SIZE,
      FULL_QUALITY,
    );

    expect(thumb.data).toBe(input);
    expect(thumb.format).toBe("image/jpeg");
    expect(thumb.keptOriginal).toBe(true);
    expect(full.data).toBe(input);
    expect(full.keptOriginal).toBe(true);
    expect(canvasStubs.length).toBe(0);
    expect(ctxStubs.length).toBe(0);
  });

  it("re-encodes the thumb but keeps the original for the full variant (800x800)", async () => {
    installCanvasStub();
    installBitmapStub(800, 800);
    const input = new Uint8Array([0xff, 0xd8, 1, 1, 1, 0xff, 0xd9]);

    const thumb = await compressCoverImage(
      input,
      "image/jpeg",
      THUMB_MAX_SIZE,
      THUMB_QUALITY,
    );
    const full = await compressCoverImage(
      input,
      "image/jpeg",
      FULL_MAX_SIZE,
      FULL_QUALITY,
    );

    expect(thumb.keptOriginal).toBe(false);
    expect(canvasStubs[0]?.width).toBe(256);
    expect(full.keptOriginal).toBe(true);
    expect(full.data).toBe(input);
    expect(canvasStubs.length).toBe(1);
  });

  it("throws InvalidImageError when decode fails", async () => {
    installCanvasStub();
    installBitmapStub(0, 0);
    vi.mocked(
      globalThis.createImageBitmap as ReturnType<typeof vi.fn>,
    ).mockRejectedValueOnce(new Error("Image decode error"));

    await expect(
      compressCoverImage(
        new Uint8Array([1, 2, 3]),
        "image/jpeg",
        THUMB_MAX_SIZE,
        THUMB_QUALITY,
      ),
    ).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("fills the canvas white before drawing when the source format has alpha (PNG)", async () => {
    installCanvasStub();
    installBitmapStub(500, 500);

    await compressCoverImage(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      "image/png",
      THUMB_MAX_SIZE,
      THUMB_QUALITY,
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

    await compressCoverImage(
      new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]),
      "image/jpeg",
      THUMB_MAX_SIZE,
      THUMB_QUALITY,
    );

    const ctx = ctxStubs[0];
    expect(ctx?.imageSmoothingQuality).toBe("high");
  });

  it("throws CoverEncodeError when the canvas blob conversion fails", async () => {
    installCanvasStub({ failConvert: true });
    installBitmapStub(2000, 2000);

    await expect(
      compressCoverImage(
        new Uint8Array([1, 2, 3]),
        "image/jpeg",
        THUMB_MAX_SIZE,
        THUMB_QUALITY,
      ),
    ).rejects.toBeInstanceOf(CoverEncodeError);
  });
});
