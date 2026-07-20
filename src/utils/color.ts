const IMAGE_LOAD_TIMEOUT_MS = 10000;

// P0-2 regression: decoding a cover image + running 4 quadrant getImageData
// loops is expensive. getPalette was called on EVERY cover load (every track
// switch / auto-advance) with the FULL (often multi-MB) cover URL and no
// memoization, burning CPU on the main thread. Cache the resolved palette per
// URL so an identical cover is decoded at most once; we return the SAME array
// reference on a cache hit (lets tests assert a memo hit cheaply).
const MAX_PALETTE_CACHE = 500;
const paletteCache = new Map<string, string[]>();

function getPaletteCached(url: string): string[] | undefined {
  const hit = paletteCache.get(url);
  if (hit !== undefined) {
    paletteCache.delete(url);
    paletteCache.set(url, hit);
  }
  return hit;
}

function setPaletteCached(url: string, palette: string[]): void {
  if (paletteCache.size >= MAX_PALETTE_CACHE) {
    const oldest = paletteCache.keys().next().value;
    if (oldest !== undefined) paletteCache.delete(oldest);
  }
  paletteCache.set(url, palette);
}

export const getPalette = (imgUrl: string): Promise<string[]> => {
  const cached = getPaletteCached(imgUrl);
  if (cached) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";

    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error("Image load timeout"))), IMAGE_LOAD_TIMEOUT_MS);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      try { action(); } finally { img.src = ""; }
    };

    img.onload = () => finish(() => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return reject(new Error("No canvas context"));

      const size = 64;
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
        for (let i = 0; i < imgData.length; i += 16) {
          const p = i / 4;
          const x = p % size;
          const y = (p / size) | 0;
          const q = (y < half ? 0 : 2) + (x < half ? 0 : 1);
          sum[q].r += imgData[i];
          sum[q].g += imgData[i + 1];
          sum[q].b += imgData[i + 2];
          sum[q].n++;
        }

        const darken = 0.5; // Darken slightly more for rich background
        const palette = sum.map((s) => {
          if (s.n === 0) return 'rgba(0,0,0,0.8)';
          const r = Math.floor((s.r / s.n) * darken);
          const g = Math.floor((s.g / s.n) * darken);
          const b = Math.floor((s.b / s.n) * darken);
          return `rgba(${r}, ${g}, ${b}, 0.8)`; // Add slight transparency for better blending
        });
        setPaletteCached(imgUrl, palette);
        resolve(palette);
      } catch (e) {
        console.warn('[color] getPalette canvas error', e);
        reject(e);
      }
    });
    img.onerror = () => finish(() => reject(new Error("Image load error")));
    img.src = imgUrl;
  });
};
