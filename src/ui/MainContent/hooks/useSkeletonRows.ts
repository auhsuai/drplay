import { useSyncExternalStore } from "react";

// Estimated height of the sticky header chrome (TopNavigationBar + SelectionToolbar)
// — the file-list container sizes itself to fill the viewport below it
// (applied as min-height: calc(100% - 140px) on the [data-drop-region] div).
export const HEADER_CHROME_HEIGHT_PX = 140;

// Skeleton row ≈ 72px tall: 48px icon + p-3 (12px) padding top/bottom.
const SKELETON_ROW_HEIGHT_PX = 72;
// Minimum skeleton rows so short viewports never collapse the loading UI.
const SKELETON_MIN_ROWS = 4;

// Skeleton rows must fill the whole list area on every screen size — a
// fixed count leaves a blank band on tall/wide displays. Estimate the
// count from the viewport and recompute on resize, like Spotify/YouTube
// skeletons do.
const calcSkeletonRows = () =>
  Math.max(
    SKELETON_MIN_ROWS,
    Math.ceil(
      (window.innerHeight - HEADER_CHROME_HEIGHT_PX) / SKELETON_ROW_HEIGHT_PX,
    ),
  );

// Recompute the skeleton row count on resize so the loading state keeps
// filling the list area after a window size change. Module-level subscribe/
// getSnapshot pair (React useSyncExternalStore pattern) — calcSkeletonRows is
// deterministic, so the snapshot is Object.is-stable between resizes.
const subscribeResize = (callback: () => void): (() => void) => {
  window.addEventListener("resize", callback);
  return () => {
    window.removeEventListener("resize", callback);
  };
};

export function useSkeletonRows(): number {
  return useSyncExternalStore(subscribeResize, calcSkeletonRows);
}
