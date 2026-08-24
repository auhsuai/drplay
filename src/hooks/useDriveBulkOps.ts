import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { db } from "../db/db";
import {
  deleteFile,
  moveFile,
  createFolder,
  FOLDER_MIME,
} from "../utils/driveApi";
import { stopPlaybackIfTrack } from "../utils/stopPlayback";
import { isUploading } from "../utils/uploadManager";
import { showErrorToast } from "../utils/simpleToast";
import { t } from "i18next";
import { captureError } from "../utils/errorLog";
import { getCurrentUserEmail } from "../utils/storageKeys";

// Bulk ops must never touch items that are still uploading (a pending row can
// not be deleted/moved — it has no Drive id yet). Excluded ids get a toast and
// the rest of the batch proceeds unchanged.
function filterUploading(ids: string[]): string[] {
  return ids.filter((id) => !isUploading(id));
}

// Shared pre-flight for bulk delete/move: drop ids still uploading, toast once
// if any were excluded, and return null when the whole selection was blocked
// (caller bails out early, selection stays untouched).
function prepareBulkSelection(
  selectedIds: Set<string>,
  toast: typeof showErrorToast,
): string[] | null {
  const ids = filterUploading([...selectedIds]);
  if (ids.length < selectedIds.size) {
    toast(t("upload.uploading_blocked"));
  }
  return ids.length === 0 ? null : ids;
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
  // Same-tick race guards (mirror useMenuDelete's isDeletingRef /
  // useMenuDownload's isDownloadingRef): a double invoke in the same tick —
  // double click, or Enter firing while the disabled button state is still
  // stale — runs before React commits the is* boolean, so only a synchronous
  // check-and-set ref can stop the second call from reaching the API.
  const isCreatingFolderRef = useRef(false);
  const isBulkDeletingRef = useRef(false);

  const handleCreateFolder = async (
    folderName: string,
    onComplete: () => void,
  ) => {
    if (!token) return;
    if (isCreatingFolderRef.current) return;
    isCreatingFolderRef.current = true;
    setIsCreatingFolder(true);
    try {
      const res = await createFolder(token, folderName, currentFolderId);
      if (res.id) {
        await db.files.put({
          id: res.id,
          name: res.name || folderName,
          parentId: currentFolderId,
          mimeType: FOLDER_MIME,
          isFolder: true,
          trashed: false,
          modifiedTime: new Date().toISOString(),
          userEmail: getCurrentUserEmail(),
        });
      }
      onRefresh();
      // onComplete only on success (not in finally): keep the modal open on
      // failure so the typed folder name survives for a retry — the error
      // toast explains what went wrong while isCreatingFolder resets in
      // finally.
      onComplete();
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useDriveBulkOps",
        message: `create-folder failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.create_folder_error"));
      // Rethrow AFTER the capture/toast above (controlled rethrow — the hook
      // stays the single owner of error UX): the awaiting caller (the modal
      // via onCreate) can then tell failure from success and keep the typed
      // folder name for a retry.
      throw e;
    } finally {
      isCreatingFolderRef.current = false;
      setIsCreatingFolder(false);
    }
  };

  const handleBulkDelete = async (onComplete: () => void) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToDelete = prepareBulkSelection(selectedIds, showErrorToast);
    if (itemsToDelete === null) return;

    // Same-tick race guard (see the refs above): must run before any state
    // mutation so a second invocation cannot re-clear the selection or issue
    // duplicate deleteFile calls.
    if (isBulkDeletingRef.current) return;
    isBulkDeletingRef.current = true;

    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setIsBulkOperating(true);
    // Close the confirm dialog right away — the batch runs in the background
    // (industry standard: NN/g + Material 3 — dialogs close on confirm, errors
    // surface via toast). NOT in finally: a pre-flight failure above must
    // keep the dialog open so the user sees the selection error.
    onComplete();

    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToDelete) {
        try {
          await deleteFile(token, id);
          deletedIds.push(id);
          // If this file is the track currently playing, stop it right away —
          // never keep playing audio that no longer exists. Only after a
          // successful Drive delete (a failed delete falls into catch).
          stopPlaybackIfTrack(id);
        } catch (e: unknown) {
          failedIds.push(id);
          void captureError({
            level: "error",
            source: "useDriveBulkOps",
            message: `bulk-delete failed for item ${id}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      if (deletedIds.length > 0) {
        // Compound PK (schema v10): delete by [userEmail, id] pairs.
        const ownerEmail = getCurrentUserEmail();
        await db.files.bulkDelete(
          deletedIds.map((id) => [ownerEmail, id] as [string, string]),
        );
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
        source: "useDriveBulkOps",
        message: `bulk-delete unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.delete_error"));
    } finally {
      isBulkDeletingRef.current = false;
      setIsBulkOperating(false);
    }
  };

  const handleBulkMove = async (
    destinationFolderId: string,
    onComplete: () => void,
  ) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToMove = prepareBulkSelection(selectedIds, showErrorToast);
    if (itemsToMove === null) return;

    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setIsBulkOperating(true);
    // Close the folder-selection screen right away — the move runs in the
    // background (same industry-standard rationale as bulk delete above).
    onComplete();

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
            source: "useDriveBulkOps",
            message: `bulk-move failed for item ${id}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
      // Single transaction for the whole batch (vs. one update() per item);
      // missing keys are skipped without throwing, same as update(). Keys are
      // compound [userEmail, id] pairs (schema v10).
      const ownerEmail = getCurrentUserEmail();
      await db.files.bulkUpdate(
        movedIds.map((id) => ({
          key: [ownerEmail, id] as [string, string],
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
        source: "useDriveBulkOps",
        message: `bulk-move unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("drive.move_error"));
    } finally {
      setIsBulkOperating(false);
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
