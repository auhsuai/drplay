import { useState } from "react";
import { DRAG_ACTIVE_EVENT } from "../../components/DropZone";
import { useEventListener } from "../../../hooks/useEventListener";

// While a native drag is in flight (DropZone announces it), the header
// chrome and pagination hide so the drop target area is unambiguous; the
// file-list container also doubles as the scoped dim region ([data-drop-region]).
export function useDragActiveState(): boolean {
  const [isDragActive, setIsDragActive] = useState(false);

  const handleDragActive = (e: Event) => {
    // detail is typed | null because a CustomEvent constructed without the
    // detail option defaults to null at runtime.
    const detail = (e as CustomEvent<{ active: boolean } | null>).detail;
    setIsDragActive(detail?.active ?? false);
  };
  useEventListener(DRAG_ACTIVE_EVENT, handleDragActive);

  return isDragActive;
}
