import { useState } from "react";
import { deleteFile } from "../utils/driveApi";
import { db } from "../db/db";
import { stopPlaybackIfTrack } from "../utils/stopPlayback";
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
      // If the deleted file is the track currently playing, stop it right
      // away — never keep playing audio that no longer exists. Only after a
      // successful Drive delete (a failed delete falls to catch, no stop).
      stopPlaybackIfTrack(deleteDriveItem.id);
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useMenuDelete",
        message: `Failed to delete item: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.delete_error"));
      return;
    } finally {
      setIsDeleting(false);
    }
    // Remote delete succeeded — a local cache failure must never surface as
    // a failed delete (Drive holds the source of truth). Log it as a warn,
    // then keep the success-path UI updates so no ghost item remains.
    try {
      await db.files.delete(deleteDriveItem.id);
    } catch (e: unknown) {
      void captureError({
        level: "warn",
        source: "useMenuDelete",
        message: `Failed to remove local cache entry: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    setShowDeleteConfirm(false);
    setIsOpen(false);
    onClose?.();
    if (onRemoveItem) onRemoveItem(deleteDriveItem.id);
    else if (onRefresh) onRefresh();
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
