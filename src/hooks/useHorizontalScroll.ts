import { useEffect, useRef } from "react";
import { captureError } from "../utils/errorLog";

const HORIZONTAL_SCROLL_MODULE = "useHorizontalScroll";
const DRAG_THRESHOLD_PX = 5;

// Shared wheel + pointer-drag horizontal scrolling for an overflow-x-auto
// container whose scrollbar is hidden (App.css hides every scrollbar). Single
// source of truth for the breadcrumbs (TopNavigationBar + FolderBreadcrumb):
// - mouse wheel emits deltaY, which overflow-x-auto does not map to
//   scrollLeft, so the wheel handler feeds deltaY + deltaX into scrollLeft.
// - React 19 attaches wheel passively at the root where preventDefault would
//   be ignored, hence a native non-passive listener.
export function useHorizontalScroll<T extends HTMLElement = HTMLDivElement>(
  enabled = true,
) {
  const ref = useRef<T | null>(null);
  const dragStartRef = useRef<{
    startX: number;
    startScrollLeft: number;
  } | null>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      el.scrollLeft += e.deltaY + e.deltaX;
    };

    // Why: capture only starts once the pointer actually moves beyond
    // DRAG_THRESHOLD_PX. Capturing on pointerdown would retarget pointerup
    // (and the subsequent click) to this container, so a plain click on a
    // crumb button would never fire its onClick.
    const onPointerDown = (e: PointerEvent) => {
      dragStartRef.current = {
        startX: e.clientX,
        startScrollLeft: el.scrollLeft,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      if (!isDraggingRef.current) {
        if (Math.abs(e.clientX - drag.startX) <= DRAG_THRESHOLD_PX) return;
        isDraggingRef.current = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch (err) {
          void captureError({
            level: "warn",
            source: HORIZONTAL_SCROLL_MODULE,
            message: `set-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      el.scrollLeft = drag.startScrollLeft - (e.clientX - drag.startX);
    };

    const endDrag = (e: PointerEvent) => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        try {
          if (el.hasPointerCapture(e.pointerId)) {
            el.releasePointerCapture(e.pointerId);
          }
        } catch (err) {
          void captureError({
            level: "warn",
            source: HORIZONTAL_SCROLL_MODULE,
            message: `release-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      dragStartRef.current = null;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endDrag);
      el.removeEventListener("pointercancel", endDrag);
    };
  }, [enabled]);

  return ref;
}
