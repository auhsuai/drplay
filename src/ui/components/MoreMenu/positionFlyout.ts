/** Breathing room between a flyout and the viewport edge, in CSS px. */
const FLYOUT_VIEWPORT_MARGIN_PX = 8;

/** Gap between a parent row and its flyout. Mirrors the old `ml-3` / `mr-3`. */
const FLYOUT_GAP_PX = 12;

/** The cascade direction decided by the first flyout (`depth === 0`). */
export type CascadeSideRef = { current: "left" | "right" | null };

/**
 * Place one flyout against its parent row, measured for real.
 *
 * Runs from the panel's ref callback, i.e. after the DOM node exists — which
 * is the only moment its HEIGHT is knowable. A pure-CSS `top-0` / `left-full`
 * cannot express "unless there is no room", which is exactly the whole
 * problem: a queue flyout opened from a row near the bottom of the screen
 * used to run off it.
 *
 * Rules:
 *  - vertically, the panel's top tracks the row's top whenever that fits;
 *    otherwise it slides up until its bottom clears the viewport edge. Each
 *    level clamps on its own — its height is its own.
 *  - horizontally the side is INHERITED from the first flyout (`depth === 0`
 *    decides, every deeper level follows). Deciding per level is what made a
 *    left-opening submenu's child flip back right and overlap the root.
 *
 * Idempotent: the same inputs always produce the same two properties, so the
 * ref callback re-firing on a re-render cannot make the panel jump. Nothing
 * re-measures while the pointer moves, so travelling between a row and its
 * flyout never shifts it.
 */
export function positionFlyout(
  panel: HTMLDivElement,
  depth: number,
  cascadeSide: CascadeSideRef,
): void {
  const parent = panel.offsetParent;
  if (!(parent instanceof HTMLElement)) return;
  const row = parent.getBoundingClientRect();
  const margin = FLYOUT_VIEWPORT_MARGIN_PX;

  const highest = Math.max(
    margin,
    window.innerHeight - panel.offsetHeight - margin,
  );
  const desiredTop = Math.min(Math.max(row.top, margin), highest);
  panel.style.top = `${String(Math.round(desiredTop - row.top))}px`;

  const roomOnRight =
    row.right + FLYOUT_GAP_PX + panel.offsetWidth + margin <= window.innerWidth;
  const side =
    depth === 0
      ? roomOnRight
        ? "right"
        : "left"
      : (cascadeSide.current ?? (roomOnRight ? "right" : "left"));
  if (depth === 0) cascadeSide.current = side;

  const beside = `calc(100% + ${String(FLYOUT_GAP_PX)}px)`;
  panel.style.left = side === "right" ? beside : "auto";
  panel.style.right = side === "left" ? beside : "auto";
}
