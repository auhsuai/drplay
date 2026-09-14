import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { db } from "../db/db";
import { upsertFileRows } from "../db/fileRows";
import {
  deleteFile,
  moveFile,
  createFolder,
  FOLDER_MIME,
} from "../utils/driveApi";
import { stopPlaybackIfTrack } from "../utils/stopPlayback";
import { showErrorToast } from "../utils/simpleToast";
import { createSemaphore } from "../utils/asyncLimit";
import { t } from "i18next";
import { captureError } from "../utils/errorLog";
import { getCurrentUserEmail } from "../utils/storageKeys";

// Bulk Drive ops are I/O-bound (~200-400ms per item) and driveFetch already
// retries 429/5xx with backoff — 5 in-flight requests per batch keeps large
// selections from taking minutes while staying polite to the rate limiter.
const BULK_CONCURRENCY = 5;

// Shared pre-flight for bulk delete/move: snapshot the selection. Kept as a
// function so both bulk handlers share one call shape.
function prepareBulkSelection(selectedIds: Set<string>): string[] | null {
  const ids = [...selectedIds];
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

  const handleCreateFolder = async (
    folderName: string,
    onComplete: () => void,
  ) => {
    if (!token) return;
    setIsCreatingFolder(true);
    try {
      const res = await createFolder(token, folderName, currentFolderId);
      if (res.id) {
        // Parent truth: the created folder's own Drive response parents when
        // the API echoes them back (files.create returns a File resource with
        // parents[]); otherwise the operation's own target — the request
        // itself placed the folder under currentFolderId. Either way the row
        // goes through the single write helper (canonical parent rule).
        await upsertFileRows(
          [
            {
              id: res.id,
              name: res.name || folderName,
              mimeType: FOLDER_MIME,
              isFolder: true,
              trashed: false,
              modifiedTime: new Date().toISOString(),
              parents:
                res.parents !== undefined && res.parents.length > 0
                  ? res.parents
                  : [currentFolderId],
              // Provisional userEmail (type-required) — the helper stamps its
              // own ownerEmail argument authoritatively.
              userEmail: getCurrentUserEmail(),
            },
          ],
          getCurrentUserEmail(),
        );
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
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const handleBulkDelete = async (onComplete: () => void) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToDelete = prepareBulkSelection(selectedIds);
    if (itemsToDelete === null) return;

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
      const semaphore = createSemaphore(BULK_CONCURRENCY);
      await Promise.all(
        itemsToDelete.map((id) =>
          semaphore.run(async () => {
            try {
              await deleteFile(token, id);
              deletedIds.push(id);
              // If this file is the track currently playing, stop it right
              // away — never keep playing audio that no longer exists. Only
              // after a successful Drive delete (a failed delete falls into
              // catch).
              stopPlaybackIfTrack(id);
            } catch (e: unknown) {
              failedIds.push(id);
              void captureError({
                level: "error",
                source: "useDriveBulkOps",
                message: `bulk-delete failed for fileId=${id}: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }),
        ),
      );
      if (deletedIds.length > 0) {
        // Local mirror write is INDEPENDENT teardown: a Dexie failure must
        // not skip the queue eviction below — the Drive delete already
        // succeeded for every id in deletedIds.
        try {
          // Compound PK (schema v10): delete by [userEmail, id] pairs.
          const ownerEmail = getCurrentUserEmail();
          await db.files.bulkDelete(
            deletedIds.map((id) => [ownerEmail, id] as [string, string]),
          );
        } catch (e: unknown) {
          void captureError({
            level: "error",
            source: "useDriveBulkOps",
            message: `local-mirror-delete-failed count=${String(deletedIds.length)}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
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
      setIsBulkOperating(false);
    }
  };

  const handleBulkMove = async (
    destinationFolderId: string,
    onComplete: () => void,
  ) => {
    if (!token || selectedIds.size === 0) return;

    const itemsToMove = prepareBulkSelection(selectedIds);
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
      const semaphore = createSemaphore(BULK_CONCURRENCY);
      await Promise.all(
        itemsToMove.map((id) =>
          semaphore.run(async () => {
            try {
              await moveFile(token, id, currentFolderId, destinationFolderId);
              movedIds.push(id);
            } catch (e: unknown) {
              failedIds.push(id);
              void captureError({
                level: "error",
                source: "useDriveBulkOps",
                message: `bulk-move failed for fileId=${id}: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }),
        ),
      );
      // Local mirror write is INDEPENDENT teardown: a Dexie failure must not
      // skip the queue eviction below — the Drive move already succeeded for
      // every id in movedIds. Single transaction for the whole batch (vs. one
      // update() per item); missing keys are skipped without throwing, same
      // as update(). Keys are compound [userEmail, id] pairs (schema v10).
      try {
        const ownerEmail = getCurrentUserEmail();
        await db.files.bulkUpdate(
          movedIds.map((id) => ({
            key: [ownerEmail, id] as [string, string],
            changes: { parentId: destinationFolderId },
          })),
        );
      } catch (e: unknown) {
        void captureError({
          level: "error",
          source: "useDriveBulkOps",
          message: `local-mirror-move-failed count=${String(movedIds.length)}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
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
