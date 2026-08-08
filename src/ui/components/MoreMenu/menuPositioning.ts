import type { CSSProperties } from "react";
import { MENU_ESTIMATED_HEIGHT_PX } from "./constants";

export interface ContextMenuStyleParams {
  anchorPoint?: { x: number; y: number } | null | undefined;
  buttonRect: DOMRect | null;
  openUpwards: boolean;
}

export function getContextMenuStyle({
  anchorPoint,
  buttonRect,
  openUpwards,
}: ContextMenuStyleParams): CSSProperties | undefined {
  if (anchorPoint) {
    const style: CSSProperties = {};
    if (anchorPoint.x > window.innerWidth / 2)
      style.right = window.innerWidth - anchorPoint.x;
    else style.left = anchorPoint.x;

    if (anchorPoint.y > window.innerHeight / 2)
      style.bottom = window.innerHeight - anchorPoint.y;
    else style.top = anchorPoint.y;
    return style;
  }

  if (buttonRect) {
    const style: CSSProperties = {};
    style.right = window.innerWidth - buttonRect.right;
    if (openUpwards) style.bottom = window.innerHeight - buttonRect.top + 8;
    else style.top = buttonRect.bottom + 8;
    return style;
  }
  return undefined;
}

export function shouldOpenUpwards(buttonRect: DOMRect): boolean {
  return buttonRect.bottom + MENU_ESTIMATED_HEIGHT_PX > window.innerHeight;
}
