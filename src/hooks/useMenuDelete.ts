import { useState } from 'react';
import { deleteFile } from '../utils/driveApi';
import { db } from '../db/db';
import { showErrorToast } from '../utils/simpleToast';
import { DriveItem } from '../App';
import { TFunction } from 'i18next';

export function useMenuDelete(t: TFunction) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteDriveItem, setDeleteDriveItem] = useState<DriveItem | null>(null);

  const handleDelete = async (
    token: string | null | undefined, 
    setIsOpen: (o: boolean) => void,
    onClose?: () => void,
    onRemoveItem?: (id: string) => void,
    onRefresh?: () => void
  ) => {
    if (!deleteDriveItem || !token) return;
    setIsDeleting(true);
    try {
      await deleteFile(token, deleteDriveItem.id);
      await db.files.delete(deleteDriveItem.id);
      setShowDeleteConfirm(false);
      setIsOpen(false);
      onClose?.();
      if (onRemoveItem) onRemoveItem(deleteDriveItem.id);
      else if (onRefresh) onRefresh();
    } catch (e) {
      console.error("[useMenuDelete] Failed to delete item", e);
      showErrorToast(t('drive.delete_error', 'Failed to delete item'));
    } finally {
      setIsDeleting(false);
    }
  };

  const openDeleteConfirm = (item: DriveItem) => {
    setDeleteDriveItem(item);
    setShowDeleteConfirm(true);
  };

  return {
    isDeleting,
    showDeleteConfirm,
    setShowDeleteConfirm,
    deleteDriveItem,
    handleDelete,
    openDeleteConfirm
  };
}
