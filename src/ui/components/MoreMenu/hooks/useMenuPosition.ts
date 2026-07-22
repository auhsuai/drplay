import React from "react";

export function getContextMenuStyle(
  anchorPoint: { x: number; y: number } | null | undefined,
  buttonRect: DOMRect | null,
  openUpwards: boolean,
): React.CSSProperties | undefined {
  if (anchorPoint) {
    const style: React.CSSProperties = {};
    if (anchorPoint.x > window.innerWidth / 2) {
      style.right = window.innerWidth - anchorPoint.x;
    } else {
      style.left = anchorPoint.x;
    }
    if (anchorPoint.y > window.innerHeight / 2) {
      style.bottom = window.innerHeight - anchorPoint.y;
    } else {
      style.top = anchorPoint.y;
    }
    return style;
  }

  if (buttonRect) {
    const style: React.CSSProperties = {};
    style.right = window.innerWidth - buttonRect.right;
    if (openUpwards) {
      style.bottom = window.innerHeight - buttonRect.top + 8;
    } else {
      style.top = buttonRect.bottom + 8;
    }
    return style;
  }

  return undefined;
}
