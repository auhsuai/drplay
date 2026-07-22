import React from "react";
import { deleteFile, moveFile } from "../../../utils/driveApi";
import { db } from "../../../db/db";
import { showErrorToast } from "../../../utils/simpleToast";
import type { TFunction } from "i18next";

interface UseBulkOperationsParams {
  token: string | null;
  currentFolderId: string;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setIsSelectionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setShowBulkDeleteConfirm: React.Dispatch<React.SetStateAction<boolean>>;
  setShowBulkMoveScreen: React.Dispatch<React.SetStateAction<boolean>>;
  isBulkOperating: boolean;
  setIsBulkOperating: React.Dispatch<React.SetStateAction<boolean>>;
  onRemoveItem?: (id: string) => void;
  t: TFunction;
}

export function useBulkOperations({
  token,
  currentFolderId,
  selectedIds,
  setSelectedIds,
  setIsSelectionMode,
  setShowBulkDeleteConfirm,
  setShowBulkMoveScreen,
  setIsBulkOperating,
  onRemoveItem,
  t,
}: UseBulkOperationsParams) {
  const handleBulkDelete = React.useCallback(async () => {
    if (!token || selectedIds.size === 0) return;
    const itemsToDelete = Array.from(selectedIds);
    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setShowBulkDeleteConfirm(false);
    setIsBulkOperating(true);

    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToDelete) {
        try {
          await deleteFile(token, id);
          deletedIds.push(id);
        } catch (e) {
          failedIds.push(id);
          console.error(`[MainContent] bulk-delete: Failed to delete item ${id}`, e);
        }
      }
      if (deletedIds.length > 0) {
        await db.files.bulkDelete(deletedIds);
        if (onRemoveItem) deletedIds.forEach(id => onRemoveItem(id));
      }
      if (failedIds.length > 0) {
        showErrorToast(t('drive.delete_error') || "Failed to delete one or more items.");
      }
    } catch (e) {
      console.error("[MainContent] bulk-delete: Unexpected error during bulk delete", e);
      showErrorToast(t('drive.delete_error') || "Failed to delete one or more items.");
    } finally {
      setIsBulkOperating(false);
    }
  }, [token, selectedIds, setSelectedIds, setIsSelectionMode, setShowBulkDeleteConfirm, setIsBulkOperating, onRemoveItem, t]);

  const handleBulkMove = React.useCallback(async (destinationFolderId: string) => {
    if (!token || selectedIds.size === 0) return;
    const itemsToMove = Array.from(selectedIds);
    setSelectedIds(new Set());
    setIsSelectionMode(false);
    setShowBulkMoveScreen(false);
    setIsBulkOperating(true);

    const movedIds: string[] = [];
    const failedIds: string[] = [];
    try {
      for (const id of itemsToMove) {
        try {
          await moveFile(token, id, currentFolderId, destinationFolderId);
          movedIds.push(id);
        } catch (e) {
          failedIds.push(id);
          console.error(`[MainContent] bulk-move: Failed to move item ${id}`, e);
        }
      }
      for (const id of movedIds) {
        await db.files.update(id, { parentId: destinationFolderId });
      }
      if (onRemoveItem && movedIds.length > 0) movedIds.forEach(id => onRemoveItem(id));
      if (failedIds.length > 0) {
        showErrorToast(t('drive.move_error') || "Failed to move one or more items.");
      }
    } catch (e) {
      console.error("[MainContent] bulk-move: Unexpected error during bulk move", e);
      showErrorToast(t('drive.move_error') || "Failed to move one or more items.");
    } finally {
      setIsBulkOperating(false);
    }
  }, [token, selectedIds, currentFolderId, setSelectedIds, setIsSelectionMode, setShowBulkMoveScreen, setIsBulkOperating, onRemoveItem, t]);

  const handleBulkMoveClick = React.useCallback(() => setShowBulkMoveScreen(true), [setShowBulkMoveScreen]);
  const handleBulkDeleteClick = React.useCallback(() => setShowBulkDeleteConfirm(true), [setShowBulkDeleteConfirm]);

  return { handleBulkDelete, handleBulkMove, handleBulkMoveClick, handleBulkDeleteClick };
}
