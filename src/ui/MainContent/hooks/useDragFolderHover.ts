import React, { useState } from "react";
import { DRAG_FOLDER_HOVER_EVENT } from "../../components/DropZone";

// DropZone's native drag-drop never triggers DOM hover, so folder cards
// subscribe to its CustomEvent bus. The compare-then-set pattern keeps
// non-target cards from re-rendering, and identical values bail React out —
// repeated 'over' events on the same folder produce no flicker.
export function useDragFolderHover({
  itemId,
  isFolder,
}: {
  itemId: string;
  isFolder: boolean;
}): boolean {
  const [isDragHovered, setIsDragHovered] = useState(false);

  React.useEffect(() => {
    if (!isFolder) return;
    const handleDragHover = (e: Event) => {
      const detail = (e as CustomEvent<{ folderId: string | null } | null>)
        .detail;
      setIsDragHovered(detail?.folderId === itemId);
    };
    window.addEventListener(DRAG_FOLDER_HOVER_EVENT, handleDragHover);
    return () => {
      window.removeEventListener(DRAG_FOLDER_HOVER_EVENT, handleDragHover);
    };
  }, [itemId, isFolder]);

  return isDragHovered;
}
