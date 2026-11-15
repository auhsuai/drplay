/**
 * Drag position of the floating download button, persisted in
 * localStorage. Coordinates are pixels from the content area's top-left
 * corner (the <main> element the button lives in) — never from the
 * window, so the clamp below is what keeps the button off the sidebar
 * and inside the screen: the content area starts at the sidebar's inner
 * edge, and the button may not leave it.
 */

export interface FabPosition {
  x: number;
  y: number;
}

export const DOWNLOAD_FAB_STORAGE_KEY = "drplay.downloadFab.position";
/** The button is a 56px circle (w-14 h-14). */
export const DOWNLOAD_FAB_SIZE_PX = 56;
/** Minimum gap to the content-area edges, matching the toast edges. */
export const DOWNLOAD_FAB_MARGIN_PX = 16;

/** Clamp a dragged position inside the content area (its size in px). */
export function clampFabPosition(
  x: number,
  y: number,
  containerWidth: number,
  containerHeight: number,
  size: number = DOWNLOAD_FAB_SIZE_PX,
  margin: number = DOWNLOAD_FAB_MARGIN_PX,
): FabPosition {
  const maxX = Math.max(margin, containerWidth - size - margin);
  const maxY = Math.max(margin, containerHeight - size - margin);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

export function loadFabPosition(): FabPosition | null {
  try {
    const raw = localStorage.getItem(DOWNLOAD_FAB_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { x?: unknown }).x !== "number" ||
      typeof (parsed as { y?: unknown }).y !== "number" ||
      !Number.isFinite((parsed as { x: number }).x) ||
      !Number.isFinite((parsed as { y: number }).y)
    ) {
      return null;
    }
    return {
      x: (parsed as { x: number }).x,
      y: (parsed as { y: number }).y,
    };
  } catch {
    return null;
  }
}

export function saveFabPosition(position: FabPosition): void {
  try {
    localStorage.setItem(DOWNLOAD_FAB_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Private mode / quota: the button just falls back to its default
    // corner next launch. Never throw from a drag handler.
  }
}
