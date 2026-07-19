const IMAGE_LOAD_TIMEOUT_MS = 10000;

// P0-2 regression: decoding a cover image + running 4 quadrant getImageData
// loops is expensive. getPalette was called on EVERY cover load (every track
// switch / auto-advance) with the FULL (often multi-MB) cover URL and no
// memoization, burning CPU on the main thread. Cache the resolved palette per
// URL so an identical cover is decoded at most once; we return the SAME array
// reference on a cache hit (lets tests assert a memo hit cheaply).
const paletteCache = new Map<string, string[]>();

export const getPalette = (imgUrl: string): Promise<string[]> => {
  const cached = paletteCache.get(imgUrl);
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
      action();
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
        
        const getQuadrantAvg = (x0: number, y0: number, w: number, h: number) => {
          const imgData = ctx.getImageData(x0, y0, w, h).data;
          let r = 0, g = 0, b = 0, count = 0;
          for (let i = 0; i < imgData.length; i += 16) {
            r += imgData[i];
            g += imgData[i+1];
            b += imgData[i+2];
            count++;
          }
          if (count === 0) return 'rgb(0,0,0)';
          
          const darken = 0.5; // Darken slightly more for rich background
          r = Math.floor((r / count) * darken);
          g = Math.floor((g / count) * darken);
          b = Math.floor((b / count) * darken);
          return `rgba(${r}, ${g}, ${b}, 0.8)`; // Add slight transparency for better blending
        };
        
        const c1 = getQuadrantAvg(0, 0, half, half); // Top Left
        const c2 = getQuadrantAvg(half, 0, half, half); // Top Right
        const c3 = getQuadrantAvg(0, half, half, half); // Bottom Left
        const c4 = getQuadrantAvg(half, half, half, half); // Bottom Right
        
        const palette = [c1, c2, c3, c4];
        paletteCache.set(imgUrl, palette);
        resolve(palette);
      } catch (e) {
        reject(e);
      }
    });
    img.onerror = () => finish(() => reject(new Error("Image load error")));
    img.src = imgUrl;
  });
};
