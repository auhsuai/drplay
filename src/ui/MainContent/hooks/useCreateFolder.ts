import React from "react";
import { useTranslation } from "react-i18next";
import { createFolder } from "../../../utils/driveApi";
import { db } from "../../../db/db";
import { showErrorToast } from "../../../utils/simpleToast";

interface UseCreateFolderParams {
  token: string | null;
  currentFolderId: string;
  onRefresh: () => void;
  setShowNewFolderModal: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useCreateFolder({
  token,
  currentFolderId,
  onRefresh,
  setShowNewFolderModal,
}: UseCreateFolderParams) {
  const { t } = useTranslation();
  const [isCreating, setIsCreating] = React.useState(false);

  const handleCreateFolder = async (folderName: string) => {
    if (!token) return;
    setIsCreating(true);
    try {
      const res = await createFolder(token, folderName, currentFolderId);
      if (res && res.id) {
        await db.files.put({
          id: res.id,
          name: res.name || folderName,
          parentId: currentFolderId,
          mimeType: 'application/vnd.google-apps.folder',
          isFolder: true,
          trashed: false,
          modifiedTime: new Date().toISOString()
        });
      }
      setShowNewFolderModal(false);
      onRefresh();
    } catch (e) {
      console.error("[MainContent] create-folder: Failed to create folder", e);
      showErrorToast(t('drive.create_folder_error') || "Failed to create folder");
      throw e;
    } finally {
      setIsCreating(false);
    }
  };

  return { handleCreateFolder, isCreating };
}
