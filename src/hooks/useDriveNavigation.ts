import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { recordFolderVisit } from "../utils/history";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB } from "../utils/driveConstants";
import { useDriveStore } from "../store/driveStore";

export const useDriveNavigation = () => {
  const {
    appRootFolder,
    currentFolderId,
    currentFolderName,
    folderHistory,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
  } = useDriveStore(
    useShallow((state) => ({
      appRootFolder: state.appRootFolder,
      currentFolderId: state.currentFolderId,
      currentFolderName: state.currentFolderName,
      folderHistory: state.folderHistory,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
    })),
  );

  const handleOpenFolder = useCallback(
    (folderId: string, folderName: string) => {
      if (folderId === currentFolderId) return;
      setFolderHistory((prev) => [
        ...prev,
        { id: currentFolderId, name: currentFolderName },
      ]);
      setCurrentFolderId(folderId);
      setCurrentFolderName(folderName);
      void recordFolderVisit(folderId, folderName);
    },
    [
      currentFolderId,
      currentFolderName,
      setFolderHistory,
      setCurrentFolderId,
      setCurrentFolderName,
    ],
  );

  const handleBack = useCallback(() => {
    if (folderHistory.length > 0) {
      const newHistory = [...folderHistory];
      const previousFolder = newHistory.pop();
      setFolderHistory(newHistory);
      setCurrentFolderId(previousFolder?.id || appRootFolder || ROOT_FOLDER_ID);
      setCurrentFolderName(previousFolder?.name || MY_DRIVE_TAB);
    }
  }, [
    folderHistory,
    appRootFolder,
    setFolderHistory,
    setCurrentFolderId,
    setCurrentFolderName,
  ]);

  const handleBreadcrumbClick = useCallback(
    (id: string, name: string, index: number) => {
      const newHistory = folderHistory.slice(0, index);
      setFolderHistory(newHistory);
      setCurrentFolderId(id);
      setCurrentFolderName(name);
    },
    [folderHistory, setFolderHistory, setCurrentFolderId, setCurrentFolderName],
  );

  return { handleOpenFolder, handleBack, handleBreadcrumbClick };
};
