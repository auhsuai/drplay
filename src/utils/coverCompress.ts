// Cover extraction helpers for embedded album art.
//
// S2 scope: compress the cover into two JPEG variants — a thumb (≤256px,
// persisted in IDB) and a full (≤2000px, kept in a bounded in-memory LRU by
// metadata.ts and persisted to IDB when JPEG). Small images are returned
// untouched (never re-encoded, never upscaled). All decoding happens in the
// browser (Chromium/WebView2 provides createImageBitmap + OffscreenCanvas) —
// the globals are mocked in node-env tests (coverCompress.test.ts).
export const THUMB_MAX_SIZE = 256;
export const THUMB_QUALITY = 0.7;
export const FULL_MAX_SIZE = 2000;
export const FULL_QUALITY = 0.8;
export const COVER_MAX_BYTES = 50 * 1024 * 1024; // skip covers declaring more than 50MB
const WHITE_BG = "#ffffff";
// Formats that can carry an alpha channel: JPEG has none, so any alpha must be
// flattened onto a white background before encoding to JPEG.
const ALPHA_FORMATS = new Set([
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageError";
  }
}

export class CoverEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverEncodeError";
  }
}

export interface CoverCompressResult {
  data: Uint8Array;
  /** "image/jpeg" when re-encoded, the source format when kept original. */
  format: string;
  keptOriginal: boolean;
}

/**
 * Detects a cover whose bytes were cut short (the parser could not read the
 * full picture from a range-limited tokenizer). Magic-based — JPEG needs its
 * FF D9 EOI, PNG needs its IEND trailer; any other format is left alone.
 * (Pattern carried over from the legacy metadata.ts implementation.)
 */
export function isImageTruncated(data: Uint8Array): boolean {
  if (data.length < 8) return true;
  if (data[0] === 0xff && data[1] === 0xd8) {
    return !(data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9);
  }
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    const iend = new Uint8Array([
      0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const tail = data.slice(-8);
    return !iend.every((b, i) => tail[i] === b);
  }
  return false;
}

/**
 * Scales an embedded cover down to maxSize (longest edge) and encodes it as
 * JPEG at the given quality. Images that already fit are returned unchanged —
 * no re-encode, no upscale. Throws InvalidImageError on decode failure and
 * CoverEncodeError when the canvas cannot produce the JPEG blob.
 */
export async function compressCoverImage(
  data: Uint8Array,
  sourceFormat: string,
  maxSize: number,
  quality: number,
): Promise<CoverCompressResult> {
  let img: ImageBitmap;
  try {
    img = await createImageBitmap(new Blob([data], { type: sourceFormat }));
  } catch (e: unknown) {
    throw new InvalidImageError(
      `image decode failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    if (img.width <= maxSize && img.height <= maxSize) {
      return { data, format: sourceFormat, keptOriginal: true };
    }

    const scale = Math.min(maxSize / img.width, maxSize / img.height);
    const w = Math.max(1, Math.floor(img.width * scale));
    const h = Math.max(1, Math.floor(img.height * scale));

    const jpeg = await encodeJpeg(img, w, h, sourceFormat, quality);
    return { data: jpeg, format: "image/jpeg", keptOriginal: false };
  } finally {
    img.close();
  }
}

async function encodeJpeg(
  img: ImageBitmap,
  width: number,
  height: number,
  sourceFormat: string,
  quality: number,
): Promise<Uint8Array> {
  try {
    const bytes = await encodeViaOffscreenCanvas(
      img,
      width,
      height,
      sourceFormat,
      quality,
    );
    if (bytes) return bytes;
    return await encodeViaDomCanvas(img, width, height, sourceFormat, quality);
  } catch (e: unknown) {
    throw new CoverEncodeError(
      `canvas encode failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function encodeViaOffscreenCanvas(
  img: ImageBitmap,
  width: number,
  height: number,
  sourceFormat: string,
  quality: number,
): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  prepareCanvas(ctx, width, height, sourceFormat);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

async function encodeViaDomCanvas(
  img: ImageBitmap,
  width: number,
  height: number,
  sourceFormat: string,
  quality: number,
): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  prepareCanvas(ctx, width, height, sourceFormat);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
  if (!blob) throw new Error("toBlob produced no output");
  return new Uint8Array(await blob.arrayBuffer());
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function prepareCanvas(
  ctx: Ctx2D,
  width: number,
  height: number,
  sourceFormat: string,
): void {
  ctx.imageSmoothingQuality = "high";
  if (ALPHA_FORMATS.has(sourceFormat)) {
    // Flatten alpha onto white so the JPEG has no transparent (black) corners.
    ctx.fillStyle = WHITE_BG;
    ctx.fillRect(0, 0, width, height);
  }
}
