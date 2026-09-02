import type { CSSProperties } from "react";
import { MENU_ESTIMATED_HEIGHT_PX } from "./constants";

export interface ContextMenuStyleParams {
  anchorPoint?: { x: number; y: number } | null | undefined;
  buttonRect: DOMRect | null;
  openUpwards: boolean;
}

// w-60 on the portal dropdown in MoreMenu.tsx - kept here so the geometry
// and the className stay in one reviewable pair (update both together).
const MENU_WIDTH_PX = 240;
// Gap between the trigger button and a downwards-opening dropdown.
const MENU_GAP_PX = 8;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Start coordinate (left/top edge) of a `size`-px box whose preferred start
 * would spill past a viewport edge: shift it just enough to fit inside
 * [0, limit]; when the viewport itself is smaller than the box, pin to 0 so
 * the menu clips at the viewport edge instead of rendering off-screen.
 */
const fitStart = (
  preferredStart: number,
  size: number,
  limit: number,
): number => Math.max(Math.min(preferredStart, Math.max(limit - size, 0)), 0);

export function getContextMenuStyle({
  anchorPoint,
  buttonRect,
  openUpwards,
}: ContextMenuStyleParams): CSSProperties | undefined {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (anchorPoint) {
    const style: CSSProperties = {};
    // Same half-split side preference as before; fitStart only shifts the box
    // when the preferred placement would spill past an edge (long-press near
    // any border, or a window smaller than the menu). Whenever the point has
    // room, emitted values are identical to the pre-clamp behavior.
    if (anchorPoint.x > vw / 2) {
      const start = fitStart(anchorPoint.x - MENU_WIDTH_PX, MENU_WIDTH_PX, vw);
      style.right = vw - start - MENU_WIDTH_PX;
    } else {
      style.left = fitStart(anchorPoint.x, MENU_WIDTH_PX, vw);
    }

    if (anchorPoint.y > vh / 2) {
      const start = fitStart(
        anchorPoint.y - MENU_ESTIMATED_HEIGHT_PX,
        MENU_ESTIMATED_HEIGHT_PX,
        vh,
      );
      style.bottom = vh - start - MENU_ESTIMATED_HEIGHT_PX;
    } else {
      style.top = fitStart(anchorPoint.y, MENU_ESTIMATED_HEIGHT_PX, vh);
    }
    return style;
  }

  if (buttonRect) {
    const style: CSSProperties = {};
    // Right-aligned to the trigger as before, but pinned flush-left when the
    // trigger sits closer than one menu width to the left viewport edge
    // (also covers a stale rect after resize/rotation while the menu is open).
    const hStart = fitStart(
      buttonRect.right - MENU_WIDTH_PX,
      MENU_WIDTH_PX,
      vw,
    );
    style.right = vw - hStart - MENU_WIDTH_PX;
    if (openUpwards) {
      // Bottom-aligned 8px above the trigger; clamped so the estimated menu
      // height never pushes the top edge above the viewport.
      const vStart = fitStart(
        buttonRect.top - MENU_GAP_PX - MENU_ESTIMATED_HEIGHT_PX,
        MENU_ESTIMATED_HEIGHT_PX,
        vh,
      );
      style.bottom = vh - vStart - MENU_ESTIMATED_HEIGHT_PX;
    } else {
      style.top = clamp(
        buttonRect.bottom + MENU_GAP_PX,
        0,
        Math.max(vh - MENU_ESTIMATED_HEIGHT_PX, 0),
      );
    }
    return style;
  }
  return undefined;
}

export function shouldOpenUpwards(buttonRect: DOMRect): boolean {
  return buttonRect.bottom + MENU_ESTIMATED_HEIGHT_PX > window.innerHeight;
}
