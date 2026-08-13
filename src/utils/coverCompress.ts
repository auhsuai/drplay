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
 * A single cover variant: longest-edge cap + JPEG quality. Grouped so
 * compressCoverVariants can describe N variants without N parameters.
 */
export interface CoverVariantSpec {
  /** Longest-edge cap for this variant; smaller images are returned untouched. */
  maxSize: number;
  /** JPEG quality used when this variant must be re-encoded. */
  quality: number;
}

/**
 * Outcome of one variant. A successful variant carries the compressed bytes;
 * a failed variant carries its CoverEncodeError (decode failures are shared
 * and thrown by compressCoverVariants, never reported here).
 */
export type CoverVariantResult =
  | { ok: true; result: CoverCompressResult }
  | { ok: false; error: CoverEncodeError };

/**
 * Decodes `data` ONCE and derives every variant from the same ImageBitmap —
 * a track cover costs a single decode no matter how many variants are
 * produced (was: one createImageBitmap per variant). Result order matches
 * `variants` order.
 *
 * Decode failure throws InvalidImageError (shared by all variants). Encode
 * failures are isolated per variant via CoverVariantResult — one broken
 * variant never drops the others, and callers can log each separately.
 */
export async function compressCoverVariants(
  data: Uint8Array,
  sourceFormat: string,
  variants: CoverVariantSpec[],
): Promise<CoverVariantResult[]> {
  if (variants.length === 0) return [];
  const img = await decodeCover(data, sourceFormat);
  try {
    const settled = await Promise.allSettled(
      variants.map((spec) => encodeVariant(img, data, sourceFormat, spec)),
    );
    return settled.map((s) => {
      if (s.status === "fulfilled") {
        return { ok: true, result: s.value };
      }
      return { ok: false, error: asCoverEncodeError(s.reason) };
    });
  } finally {
    // Exactly one close on every path (success or any encode failure): the
    // shared bitmap is disposed once after all variants consumed it.
    img.close();
  }
}

async function decodeCover(
  data: Uint8Array,
  sourceFormat: string,
): Promise<ImageBitmap> {
  try {
    // EXIF orientation is applied ("from-image" — the spec default, made
    // explicit) so camera-shot covers decode upright.
    return await createImageBitmap(new Blob([data], { type: sourceFormat }), {
      imageOrientation: "from-image",
    });
  } catch (e: unknown) {
    throw new InvalidImageError(
      `image decode failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function encodeVariant(
  img: ImageBitmap,
  originalData: Uint8Array,
  sourceFormat: string,
  spec: CoverVariantSpec,
): Promise<CoverCompressResult> {
  if (img.width <= spec.maxSize && img.height <= spec.maxSize) {
    return { data: originalData, format: sourceFormat, keptOriginal: true };
  }

  const scale = Math.min(spec.maxSize / img.width, spec.maxSize / img.height);
  const w = Math.max(1, Math.floor(img.width * scale));
  const h = Math.max(1, Math.floor(img.height * scale));

  const jpeg = await encodeJpeg(img, w, h, sourceFormat, spec.quality);
  return { data: jpeg, format: "image/jpeg", keptOriginal: false };
}

function asCoverEncodeError(reason: unknown): CoverEncodeError {
  if (reason instanceof CoverEncodeError) return reason;
  return new CoverEncodeError(
    reason instanceof Error ? reason.message : String(reason),
  );
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
    // Keep an already-typed CoverEncodeError (e.g. the JPEG type guard) as
    // its own message; wrap everything else with canvas context.
    if (e instanceof CoverEncodeError) throw e;
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
  return encodeCanvasToJpeg(img, canvas, ctx, sourceFormat, quality);
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
  return encodeCanvasToJpeg(img, canvas, ctx, sourceFormat, quality);
}

/**
 * Shared encode path for both canvas flavors (OffscreenCanvas and DOM):
 * prepare → draw → blob → bytes. Callers keep their own null-vs-throw
 * semantics for canvas creation; the JPEG type guard here fails loud
 * instead of shipping bytes the disk cache would trust as JPEG.
 */
async function encodeCanvasToJpeg(
  img: ImageBitmap,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  ctx: Ctx2D,
  sourceFormat: string,
  quality: number,
): Promise<Uint8Array> {
  prepareCanvas(ctx, canvas.width, canvas.height, sourceFormat);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob =
    typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: "image/jpeg", quality })
      : await new Promise<Blob | null>((resolve) => {
          (canvas as HTMLCanvasElement).toBlob(resolve, "image/jpeg", quality);
        });
  if (!blob) throw new Error("toBlob produced no output");
  // MDN: convertToBlob/toBlob silently export PNG when the requested type is
  // unsupported — never hand a PNG blob back as "image/jpeg".
  if (blob.type !== "image/jpeg") {
    throw new CoverEncodeError(
      `canvas encode produced ${blob.type}, expected image/jpeg`,
    );
  }
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
