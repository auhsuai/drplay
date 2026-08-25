import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { DEBUG_EVENTS, onDebugEvent } from "../../debug/debugEvents";

interface UseDebugTriggersParams {
  setShowBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  setIsSelectionMode: Dispatch<SetStateAction<boolean>>;
  setDebugTotalPages: Dispatch<SetStateAction<number | null>>;
}

// DEV-only debug triggers (Ctrl+Shift+D panel → "Loading / MainContent"):
// bulk-delete modal and selection toolbar drive the SAME local/explorer
// state the real flows use, so every subsequent interaction (close modal,
// exit selection, bulk action) keeps working unchanged. onDebugEvent no-ops
// in production builds; the listeners never run there.
export function useDebugTriggers({
  setShowBulkDeleteConfirm,
  setIsSelectionMode,
  setDebugTotalPages,
}: UseDebugTriggersParams): void {
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.BULK_DELETE, () => {
      setShowBulkDeleteConfirm(true);
    });
  }, [setShowBulkDeleteConfirm]);

  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.SELECTION_MODE, () => {
      setIsSelectionMode(true);
    });
  }, [setIsSelectionMode]);

  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.PAGINATION, () => {
      setDebugTotalPages(2);
    });
  }, [setDebugTotalPages]);
}
