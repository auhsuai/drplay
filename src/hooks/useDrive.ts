import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDriveStore } from "../store/driveStore";
import { useDriveInit } from "./useDriveInit";
import { useNavStatePersistence } from "./useNavStatePersistence";
import { useDriveNavigation } from "./useDriveNavigation";
import { useDriveRootSelector } from "./useDriveRootSelector";

export const useDrive = (isLoggedIn: boolean, accessToken: string | null) => {
  const {
    appRootFolder,
    setAppRootFolder,
    currentFolderId,
    setCurrentFolderId,
    currentFolderName,
    setCurrentFolderName,
    folderHistory,
    setFolderHistory,
    sortOption,
    setSortOption,
  } = useDriveStore(
    useShallow((state) => ({
      appRootFolder: state.appRootFolder,
      setAppRootFolder: state.setAppRootFolder,
      currentFolderId: state.currentFolderId,
      setCurrentFolderId: state.setCurrentFolderId,
      currentFolderName: state.currentFolderName,
      setCurrentFolderName: state.setCurrentFolderName,
      folderHistory: state.folderHistory,
      setFolderHistory: state.setFolderHistory,
      sortOption: state.sortOption,
      setSortOption: state.setSortOption,
    })),
  );

  // Gate the nav-state persistence effect until initApp has finished restoring.
  // Prevents the placeholder currentFolderId=ROOT_FOLDER_ID (set before hydration) from
  // being persisted and racing with the restore read, which would make the app
  // open the real Google Drive root instead of the configured app root folder.
  // useDriveInit owns hydrate() (sets hydratedRef.current = true in finally);
  // useNavStatePersistence reads the flag to gate its save effect.
  const hydratedRef = useRef(false);

  useDriveInit({ accessToken, isLoggedIn, hydratedRef });
  useNavStatePersistence({ hydratedRef, isLoggedIn });
  const { handleOpenFolder, handleBack, handleBreadcrumbClick } =
    useDriveNavigation();
  const { handleSelectRootFolder } = useDriveRootSelector();

  return {
    appRootFolder,
    setAppRootFolder,
    currentFolderId,
    setCurrentFolderId,
    currentFolderName,
    setCurrentFolderName,
    folderHistory,
    setFolderHistory,
    sortOption,
    setSortOption,
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
    handleSelectRootFolder,
  };
};
