import { captureError } from "./errorLog";

const IMAGE_LOAD_TIMEOUT_MS = 10000;
const CANVAS_SIZE = 64;
const SAMPLE_STEP = 16;
const DARKEN_FACTOR = 0.5;
const BG_ALPHA = 0.8;
// Light mode reuses the same (darkened) rgb but a low alpha so the tint
// composites over the light player background (#f3f4f6) instead of painting
// near-black blobs on it; dark keeps the original alpha tuned for #121212.
const LIGHT_BG_ALPHA = 0.3;

export type PaletteMode = "light" | "dark";

// P0-2 regression: decoding a cover image + running 4 quadrant getImageData
// loops is expensive. getPalette was called on EVERY cover load (every track
// switch / auto-advance) with the FULL (often multi-MB) cover URL and no
// memoization, burning CPU on the main thread. Cache the resolved palette per
// (url, mode) so an identical cover is decoded at most once per theme; we
// return the SAME array reference on a cache hit (lets tests assert a memo hit
// cheaply).
const MAX_PALETTE_CACHE = 500;
const paletteCache = new Map<string, string[]>();

function paletteCacheKey(mode: PaletteMode, url: string): string {
  return `${mode}:${url}`;
}

function getPaletteCached(cacheKey: string): string[] | undefined {
  const hit = paletteCache.get(cacheKey);
  if (hit !== undefined) {
    paletteCache.delete(cacheKey);
    paletteCache.set(cacheKey, hit);
  }
  return hit;
}

function setPaletteCached(cacheKey: string, palette: string[]): void {
  if (paletteCache.size >= MAX_PALETTE_CACHE) {
    const oldest = paletteCache.keys().next().value;
    if (oldest !== undefined) paletteCache.delete(oldest);
  }
  paletteCache.set(cacheKey, palette);
}

export const getPalette = (
  imgUrl: string,
  mode: PaletteMode = "dark",
): Promise<string[]> => {
  const cacheKey = paletteCacheKey(mode, imgUrl);
  const cached = getPaletteCached(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";

    let settled = false;
    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error("Image load timeout"));
      });
    }, IMAGE_LOAD_TIMEOUT_MS);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      try {
        action();
      } finally {
        img.src = "";
      }
    };

    img.onload = () => {
      finish(() => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          reject(new Error("No canvas context"));
          return;
        }

        const size = CANVAS_SIZE;
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);

        try {
          const half = size / 2;

          // Single canvas read instead of 4 quadrant reads. Bucketing each
          // sampled pixel into its quadrant avoids 3 extra GPU->RAM buffer
          // copies and the 4 intermediate typed-array views.
          const imgData = ctx.getImageData(0, 0, size, size).data;
          const sum = [
            { r: 0, g: 0, b: 0, n: 0 }, // TL
            { r: 0, g: 0, b: 0, n: 0 }, // TR
            { r: 0, g: 0, b: 0, n: 0 }, // BL
            { r: 0, g: 0, b: 0, n: 0 }, // BR
          ];
          // Sample every 4th pixel (RGBA = 4 bytes) -> step 16 bytes.
          for (let i = 0; i < imgData.length; i += SAMPLE_STEP) {
            const p = i / 4;
            const x = p % size;
            const y = (p / size) | 0;
            const q = (y < half ? 0 : 2) + (x < half ? 0 : 1);
            const r = imgData[i];
            const g = imgData[i + 1];
            const b = imgData[i + 2];
            if (r === undefined || g === undefined || b === undefined) continue;
            const bucket = sum[q];
            if (bucket === undefined) continue;
            bucket.r += r;
            bucket.g += g;
            bucket.b += b;
            bucket.n++;
          }

          const darken = DARKEN_FACTOR;
          const alpha = mode === "light" ? LIGHT_BG_ALPHA : BG_ALPHA;
          const palette = sum.map((s) => {
            if (s.n === 0) return `rgba(0,0,0,${String(alpha)})`;
            const r = Math.floor((s.r / s.n) * darken);
            const g = Math.floor((s.g / s.n) * darken);
            const b = Math.floor((s.b / s.n) * darken);
            return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(alpha)})`;
          });
          setPaletteCached(cacheKey, palette);
          resolve(palette);
        } catch (e: unknown) {
          // fire-and-forget: logging must not throw in this sync callback
          // (captureError never rejects — it swallows failures internally).
          void captureError({
            level: "warn",
            source: "color",
            message: `getPalette canvas error: ${e instanceof Error ? e.message : String(e)}`,
          });
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    };
    img.onerror = () => {
      finish(() => {
        // fire-and-forget: logging must not throw in this sync callback
        // (captureError never rejects — it swallows failures internally).
        void captureError({
          level: "warn",
          source: "color",
          message: "getPalette image load failed",
        });
        reject(new Error("Image load error"));
      });
    };
    img.src = imgUrl;
  });
};
