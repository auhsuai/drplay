import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useHardwareBack } from "../../../hooks/useHardwareBack";

interface UseBulkOverlaysHardwareBackParams {
  isBulkOperating: boolean;
  showBulkDeleteConfirm: boolean;
  showBulkMoveScreen: boolean;
  setShowBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  setShowBulkMoveScreen: Dispatch<SetStateAction<boolean>>;
}

// Hardware back (mobile): closes the two bulk overlays (BulkDeleteConfirmModal
// and bulk-move FolderSelectionScreen) when they own the foreground — without
// this, a back press falls through the App-level chain to the folder-up
// handler and pops folder history instead. BulkDeleteConfirmModal renders
// after FolderSelectionScreen in JSX, so it closes first (MoreMenu pattern:
// the later-rendered dialog is handled first). Handler closure includes every
// boolean gate in deps so the latest version is always on the LIFO stack (an
// inline `if (showBulkDeleteConfirm)` read against a stale closure would
// re-peel the same overlay twice — MoreMenu pattern). Registered ONLY while
// at least one bulk overlay is open, so an empty stack on close keeps the
// chain falling through to App.
export function useBulkOverlaysHardwareBack({
  isBulkOperating,
  showBulkDeleteConfirm,
  showBulkMoveScreen,
  setShowBulkDeleteConfirm,
  setShowBulkMoveScreen,
}: UseBulkOverlaysHardwareBackParams): void {
  const handleBulkOverlayBack = useCallback((): boolean => {
    // While a bulk operation is running the overlays must not be dismissible
    // by hardware back (CacheManagerModal/ImageCropperModal precedent): only
    // consume the event so it does not fall through to folder-up.
    if (isBulkOperating) return true;
    if (showBulkDeleteConfirm) {
      setShowBulkDeleteConfirm(false);
      return true;
    }
    if (showBulkMoveScreen) {
      setShowBulkMoveScreen(false);
      return true;
    }
    return false;
  }, [
    isBulkOperating,
    setShowBulkDeleteConfirm,
    setShowBulkMoveScreen,
    showBulkDeleteConfirm,
    showBulkMoveScreen,
  ]);

  const isAnyBulkOverlayOpen = showBulkDeleteConfirm || showBulkMoveScreen;
  useHardwareBack(handleBulkOverlayBack, isAnyBulkOverlayOpen);
}
