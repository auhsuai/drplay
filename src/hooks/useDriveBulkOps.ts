import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { db } from "../db/db";
import { deleteFile, moveFile, createFolder } from "../utils/driveApi";
import { isUploading } from "../utils/uploadManager";
import { showErrorToast } from "../utils/simpleToast";
import { t } from "i18next";
import { captureError } from "../utils/errorLog";

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

// Bulk ops must never touch items that are still uploading (a pending row can
// not be deleted/moved — it has no Drive id yet). Excluded ids get a toast and
// the rest of the batch proceeds unchanged.
function filterUploading(ids: string[]): string[] {
  return ids.filter((id) => !isUploading(id));
}

export function useDriveBulkOps({
  token,
  currentFolderId,
  selectedIds,
  onRemoveItem,
  onRefresh,
  setSelectedIds,
  setIsSelectionMode,
}: {
  token: string | null;
  currentFolderId: string;
  selectedIds: Set<string>;
  onRemoveItem?: ((id: string) => void) | undefined;
  onRefresh: () => void;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setIsSelectionMode: Dispatch<SetStateAction<boolean>>;
}): {
  isCreatingFolder: boolean;
  isBulkOperating: boolean;
  handleCreateFolder: (
    folderName: string,
    onComplete: () => void,
  ) => Promise<void>;
  handleBulkDelete: (onComplete: () => void) => Promise<void>;
  handleBulkMove: (
    destinationFolderId: string,
    onComplete: () => void,
  ) => Promise<void>;
} {
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [isBulkOperating, setIsBulkOperating] = useState(false);

  const handleCreateFolder = async (
    folderName: string,
    onComplete: () => void,
  ) => {
    if (!token) return;
    setIsCreatingFolder(true);
    try {
      const res = await createFolder(token, folderName, currentFolderId);
      if (res.id) {
        await db.files.put({
          id: res.id,
          name: res.name || folderName,
          parentId: currentFolderId,
          mimeType: GOOGLE_FOLDER_MIME,
          isFolder: true,
          trashed: false,
          modifiedTime: new Date().toISOString(),
        });
      }
      onRefresh();
      onComplete();
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useDriveExplorer",
        message: `create-folder failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.create_folder_error"));
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleBulkDelete = async (onComplete: () => void) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToDelete = filterUploading([...selectedIds]);
    if (itemsToDelete.length < selectedIds.size) {
      showErrorToast(t("upload.uploading_blocked"));
    }
    if (itemsToDelete.length === 0) return;

    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setIsBulkOperating(true);

    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToDelete) {
        try {
          await deleteFile(token, id);
          deletedIds.push(id);
        } catch (e: unknown) {
          failedIds.push(id);
          void captureError({
            level: "error",
            source: "useDriveExplorer",
            message: `bulk-delete failed for item ${id}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      if (deletedIds.length > 0) {
        await db.files.bulkDelete(deletedIds);
        if (onRemoveItem)
          deletedIds.forEach((id) => {
            onRemoveItem(id);
          });
      }
      if (failedIds.length > 0) {
        showErrorToast(t("drive.delete_error"));
      }
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useDriveExplorer",
        message: `bulk-delete unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.delete_error"));
    } finally {
      setIsBulkOperating(false);
      onComplete();
    }
  };

  const handleBulkMove = async (
    destinationFolderId: string,
    onComplete: () => void,
  ) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToMove = filterUploading([...selectedIds]);
    if (itemsToMove.length < selectedIds.size) {
      showErrorToast(t("upload.uploading_blocked"));
    }
    if (itemsToMove.length === 0) return;

    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setIsBulkOperating(true);

    const movedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToMove) {
        try {
          await moveFile(token, id, currentFolderId, destinationFolderId);
          movedIds.push(id);
        } catch (e: unknown) {
          failedIds.push(id);
          void captureError({
            level: "error",
            source: "useDriveExplorer",
            message: `bulk-move failed for item ${id}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      // Single transaction for the whole batch (vs. one update() per item);
      // missing keys are skipped without throwing, same as update().
      await db.files.bulkUpdate(
        movedIds.map((id) => ({
          key: id,
          changes: { parentId: destinationFolderId },
        })),
      );
      if (onRemoveItem && movedIds.length > 0)
        movedIds.forEach((id) => {
          onRemoveItem(id);
        });
      if (failedIds.length > 0) {
        showErrorToast(t("drive.move_error"));
      }
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useDriveExplorer",
        message: `bulk-move unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.move_error"));
    } finally {
      setIsBulkOperating(false);
      onComplete();
    }
  };

  return {
    isCreatingFolder,
    isBulkOperating,
    handleCreateFolder,
    handleBulkDelete,
    handleBulkMove,
  };
}
