import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DriveItem } from "../../../types";
import { moveFile } from "../../../utils/driveApi";
import { db } from "../../../db/db";
import { captureError } from "../../../utils/errorLog";
import { showErrorToast } from "../../../utils/simpleToast";
import { getCurrentUserEmail } from "../../../utils/storageKeys";
import { MORE_MENU_MODULE } from "./constants";

interface UseMenuMoveParams {
  driveItem?: DriveItem | undefined;
  token?: string | null | undefined;
  currentFolderId?: string | undefined;
  onRemoveItem?: ((id: string) => void) | undefined;
  onRefresh?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  setIsOpen: (open: boolean) => void;
}

export function useMenuMove({
  driveItem,
  token,
  currentFolderId,
  onRemoveItem,
  onRefresh,
  onClose,
  setIsOpen,
}: UseMenuMoveParams): {
  showMoveScreen: boolean;
  setShowMoveScreen: (value: boolean) => void;
  handleMove: (newParentId: string) => Promise<void>;
} {
  const { t } = useTranslation();
  const [showMoveScreen, setShowMoveScreen] = useState(false);

  // -- Move logic --
  const handleMove = async (newParentId: string) => {
    if (!driveItem || !token || !currentFolderId) {
      // Latent defensive path (today's callers always pass currentFolderId):
      // never leave a dead "Choose folder" button — log the reason and close
      // the picker instead of returning silently.
      void captureError({
        level: "warn",
        source: MORE_MENU_MODULE,
        message: "move-skipped: missing driveItem/token/currentFolderId",
      });
      setShowMoveScreen(false);
      return;
    }
    if (newParentId === currentFolderId) {
      setShowMoveScreen(false);
      setIsOpen(false);
      onClose?.();
      return;
    }

    const itemId = driveItem.id;
    const oldParentId = currentFolderId;

    setShowMoveScreen(false);
    setIsOpen(false);
    onClose?.();

    try {
      await moveFile(token, itemId, oldParentId, newParentId);
      if (onRemoveItem) onRemoveItem(itemId);
      // Local mirror write is INDEPENDENT teardown: the Drive move already
      // succeeded, so a Dexie failure must not surface as a move error (nor
      // skip the row removal above) — same split as useDriveBulkOps
      // (bulk-move). Missing keys are skipped without throwing.
      try {
        // Compound PK (schema v10): [userEmail, id].
        await db.files.update([getCurrentUserEmail(), itemId], {
          parentId: newParentId,
        });
      } catch (e) {
        void captureError({
          level: "error",
          source: MORE_MENU_MODULE,
          message: `local-mirror-move-failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } catch (e) {
      void captureError({
        level: "error",
        source: MORE_MENU_MODULE,
        message: `move-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.move_error"));
      if (onRefresh) onRefresh();
    }
  };

  return { showMoveScreen, setShowMoveScreen, handleMove };
}
