import { useSyncExternalStore } from "react";

// Breakpoints match Tailwind: md = 768px, lg = 1024px
function getSnapshot(): number {
  const width = window.innerWidth;
  if (width >= 1024) return 5;
  if (width >= 768) return 4;
  return 2;
}

// Module-scope so React never re-subscribes on re-render (react.dev
// useSyncExternalStore caveat). matchMedia fires only on breakpoint crossings
// instead of on every pixel of a resize (MDN Window.matchMedia). jsdom does
// NOT implement matchMedia (verified on jsdom 29) — fall back to the legacy
// resize listener so the hook still works under test.
function subscribe(onStoreChange: () => void): () => void {
  if (typeof window.matchMedia === "function") {
    const mqLg = window.matchMedia("(min-width: 1024px)");
    const mqMd = window.matchMedia("(min-width: 768px)");
    mqLg.addEventListener("change", onStoreChange);
    mqMd.addEventListener("change", onStoreChange);
    return () => {
      mqLg.removeEventListener("change", onStoreChange);
      mqMd.removeEventListener("change", onStoreChange);
    };
  }
  window.addEventListener("resize", onStoreChange);
  return () => {
    window.removeEventListener("resize", onStoreChange);
  };
}

export function useResponsiveItems(): number {
  // getSnapshot runs on the first render, so the initial count is correct
  // immediately (no flash of a wrong count before the first 'change' event —
  // same as the old handleResize() initial call).
  return useSyncExternalStore(subscribe, getSnapshot);
}
