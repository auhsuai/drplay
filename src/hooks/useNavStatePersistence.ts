import { useEffect } from "react";
import type { RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { db } from "../db/db";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import { DB_NAV_STATE_KEY } from "../utils/storageKeys";
import { VIRTUAL_ROOT_ID } from "../utils/driveConstants";
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
    rootFolders,
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
      rootFolders: state.rootFolders,
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
      // Which configured branch this position belongs to. A configured root
      // wins over the synthetic virtual node: the virtual node only proves
      // "multi-root mode", not which branch a nested folder lives in.
      const resolveRootId = (): string | undefined => {
        if (currentFolderId === VIRTUAL_ROOT_ID) return VIRTUAL_ROOT_ID;
        if (rootFolders.some((root) => root.id === currentFolderId)) {
          return currentFolderId;
        }
        const historyRoot = folderHistory.find((entry) =>
          rootFolders.some((root) => root.id === entry.id),
        );
        if (historyRoot !== undefined) return historyRoot.id;
        return folderHistory.some((entry) => entry.id === VIRTUAL_ROOT_ID)
          ? VIRTUAL_ROOT_ID
          : undefined;
      };
      const rootId = resolveRootId();
      db.syncState
        .put({
          key: DB_NAV_STATE_KEY,
          value: {
            id: currentFolderId,
            name: currentFolderName,
            history: folderHistory,
            ...(rootId === undefined ? {} : { rootId }),
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
    rootFolders,
    isLoggedIn,
    appRootFolder,
    setAppRootFolder,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
  ]);
};
