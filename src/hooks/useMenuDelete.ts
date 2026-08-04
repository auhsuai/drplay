import { useState } from "react";
import { deleteFile } from "../utils/driveApi";
import { db } from "../db/db";
import { isUploading } from "../utils/uploadManager";
import { showErrorToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";
import type { DriveItem } from "../types";
import type { TFunction } from "i18next";

export function useMenuDelete(t: TFunction) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteDriveItem, setDeleteDriveItem] = useState<DriveItem | null>(
    null,
  );

  const handleDelete = async (
    token: string | null | undefined,
    setIsOpen: (o: boolean) => void,
    onClose?: () => void,
    onRemoveItem?: (id: string) => void,
    onRefresh?: () => void,
  ) => {
    if (!deleteDriveItem || !token) return;
    // Race guard (2nd layer behind the disabled menu item): the confirm dialog
    // may already be open when an upload of this item starts — never delete a
    // file that still has a pending upload.
    if (isUploading(deleteDriveItem.id)) {
      showErrorToast(
        t(
          "upload.uploading_blocked",
          "This item is being uploaded, please wait",
        ),
      );
      setShowDeleteConfirm(false);
      return;
    }
    setIsDeleting(true);
    try {
      await deleteFile(token, deleteDriveItem.id);
      await db.files.delete(deleteDriveItem.id);
      setShowDeleteConfirm(false);
      setIsOpen(false);
      onClose?.();
      if (onRemoveItem) onRemoveItem(deleteDriveItem.id);
      else if (onRefresh) onRefresh();
    } catch (e: unknown) {
      captureError({
        level: "error",
        source: "useMenuDelete",
        message: `Failed to delete item: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.delete_error", "Failed to delete item"));
    } finally {
      setIsDeleting(false);
    }
  };

  const openDeleteConfirm = (item: DriveItem) => {
    // Race guard (1st layer, alongside the disabled menu item): never offer to
    // delete an item that is still uploading.
    if (isUploading(item.id)) {
      showErrorToast(
        t(
          "upload.uploading_blocked",
          "This item is being uploaded, please wait",
        ),
      );
      return;
    }
    setDeleteDriveItem(item);
    setShowDeleteConfirm(true);
  };

  return {
    isDeleting,
    showDeleteConfirm,
    setShowDeleteConfirm,
    deleteDriveItem,
    handleDelete,
    openDeleteConfirm,
  };
}
