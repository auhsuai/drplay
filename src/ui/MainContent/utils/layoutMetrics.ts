// Fallback delay for the cross-page highlight scroll: normally the page
// commit itself re-runs the highlight effect, whose cleanup cancels this
// timer before it fires; the timeout only performs the scroll when the new
// page renders slower than the delay (slow devices/commits).
export const SCROLL_HIGHLIGHT_DELAY_MS = 50;

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
export const calcSkeletonRows = () =>
  Math.max(
    SKELETON_MIN_ROWS,
    Math.ceil(
      (window.innerHeight - HEADER_CHROME_HEIGHT_PX) / SKELETON_ROW_HEIGHT_PX,
    ),
  );
