import { useEffect } from "react";
import type { RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { db } from "../db/db";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import { DB_NAV_STATE_KEY } from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";

interface UseNavStatePersistenceParams {
  hydratedRef: RefObject<boolean>;
  isLoggedIn: boolean;
}

export const useNavStatePersistence = ({
  hydratedRef,
  isLoggedIn,
}: UseNavStatePersistenceParams) => {
  const {
    appRootFolder,
    currentFolderId,
    currentFolderName,
    folderHistory,
    setAppRootFolder,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
  } = useDriveStore(
    useShallow((state) => ({
      appRootFolder: state.appRootFolder,
      currentFolderId: state.currentFolderId,
      currentFolderName: state.currentFolderName,
      folderHistory: state.folderHistory,
      setAppRootFolder: state.setAppRootFolder,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
    })),
  );

  // Save folder navigation state whenever it changes
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (isLoggedIn && appRootFolder) {
      db.syncState
        .put({
          key: DB_NAV_STATE_KEY,
          value: {
            id: currentFolderId,
            name: currentFolderName,
            history: folderHistory,
          },
        })
        .catch(
          (e: unknown) =>
            void captureError({
              level: "error",
              source: "useDrive",
              message: `nav-state-save-failed: ${classifyError(e)}`,
            }),
        );
    }
  }, [
    currentFolderId,
    currentFolderName,
    folderHistory,
    isLoggedIn,
    appRootFolder,
    setAppRootFolder,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
  ]);
};
