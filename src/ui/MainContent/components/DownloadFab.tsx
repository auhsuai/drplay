import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  DOWNLOAD_FAB_SIZE_PX,
  clampFabPosition,
  loadFabPosition,
  saveFabPosition,
  type FabPosition,
} from "../../../utils/downloadFabPosition";

/**
 * Floating download button (the bubble): a 56px circle with a border,
 * the exact lucide `Download` icon (24×24, stroke 2, currentColor —
 * M12 15V3, the tray, and the m7 10 5 5 5-5 chevron).
 *
 * Visibility (user's rule): ONLY while a bulk download job is running —
 * no job, no button. It lives inside MainContent's <main> (the content
 * area, i.e. inside the sidebar's inner edge), and dragging clamps it to
 * that area, so it can never cover the sidebar or leave the screen. The
 * dropped position persists in localStorage; a drag shorter than 5px is
 * a click and opens the panel instead.
 */
interface DownloadFabProps {
  visible: boolean;
  onClick: () => void;
  /** e.g. "3/14" while a job runs; shown as a small badge on the bubble. */
  badge?: string | undefined;
  /** Accessible label for the button. */
  label: string;
}

const DRAG_CLICK_THRESHOLD_PX = 5;

export function DownloadFab({
  visible,
  onClick,
  badge,
  label,
}: DownloadFabProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragged: boolean;
  } | null>(null);
  const onClickRef = useRef(onClick);
  // Sync outside render (react-hooks/refs): the pointer-up handler reads
  // the latest onClick without re-binding the drag handlers.
  useEffect(() => {
    onClickRef.current = onClick;
  });
  const [position, setPosition] = useState<FabPosition | null>(() =>
    loadFabPosition(),
  );

  // A persisted position from a larger window could sit outside a
  // smaller one: clamp once the button has a measurable container.
  useLayoutEffect(() => {
    if (!visible || !position) return;
    const button = buttonRef.current;
    const container = button?.offsetParent as HTMLElement | null;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const clamped = clampFabPosition(
      position.x,
      position.y,
      rect.width,
      rect.height,
    );
    if (clamped.x !== position.x || clamped.y !== position.y) {
      setPosition(clamped);
    }
  }, [visible, position]);

  if (!visible) return null;

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const button = buttonRef.current;
    if (!button) return;
    const container = button.offsetParent as HTMLElement | null;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const origin = position ?? {
      x: rect.width - DOWNLOAD_FAB_SIZE_PX - 16,
      y: rect.height - DOWNLOAD_FAB_SIZE_PX - 16,
    };
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: origin.x,
      originY: origin.y,
      dragged: false,
    };
    // jsdom has no active pointer to capture; a real browser does, so
    // moves outside the button still reach these handlers there.
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      // Tests: no capture, but pointer events fired on the button still
      // reach the move/up handlers.
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const button = buttonRef.current;
    const container = button?.offsetParent as HTMLElement | null;
    if (!drag || !button || !container || e.pointerId !== drag.pointerId)
      return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragged && Math.hypot(dx, dy) < DRAG_CLICK_THRESHOLD_PX) {
      return;
    }
    drag.dragged = true;
    const rect = container.getBoundingClientRect();
    setPosition(
      clampFabPosition(
        drag.originX + dx,
        drag.originY + dy,
        rect.width,
        rect.height,
      ),
    );
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (drag.dragged) {
      // Keep the dropped spot for the next launch.
      setPosition((current) => {
        if (current) saveFabPosition(current);
        return current;
      });
      return;
    }
    onClickRef.current();
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      className="absolute z-40 w-14 h-14 rounded-full border border-gray-300 dark:border-white/25 bg-white dark:bg-[#2a2b2f] text-gray-900 dark:text-white shadow-xl flex items-center justify-center touch-none select-none cursor-grab active:cursor-grabbing hover:shadow-2xl transition-shadow"
      style={
        position
          ? { left: position.x, top: position.y }
          : { right: 16, bottom: 16 }
      }
    >
      <Download className="w-6 h-6 pointer-events-none" strokeWidth={2} />
      {badge !== undefined && (
        <span
          aria-hidden="true"
          className="absolute -top-1.5 -right-1.5 rounded-full bg-brand-primary text-white text-[10px] leading-none font-semibold px-1.5 py-1 pointer-events-none"
        >
          {badge}
        </span>
      )}
    </button>
  );
}
