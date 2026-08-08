import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { saveAppConfig } from "../utils/driveApi";
import { getValidToken } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { MY_DRIVE_TAB } from "../utils/driveConstants";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import { ROOT_FOLDER_KEY } from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";

export const useDriveRootSelector = () => {
  const {
    setAppRootFolder,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
  } = useDriveStore(
    useShallow((state) => ({
      setAppRootFolder: state.setAppRootFolder,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
    })),
  );

  const handleSelectRootFolder = useCallback(
    async (folderId: string) => {
      try {
        localStorage.setItem(ROOT_FOLDER_KEY, folderId);
      } catch (err) {
        void captureError({
          level: "warn",
          source: "useDrive",
          message: `root-folder-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
        });
      }
      setAppRootFolder(folderId);
      setCurrentFolderId(folderId);
      setCurrentFolderName(MY_DRIVE_TAB);
      setFolderHistory([]);
      try {
        await db.files.clear();
        await invoke(CLEAR_LOCAL_CACHE_CMD);
        const freshToken = await getValidToken();
        if (freshToken) {
          try {
            const saved = await saveAppConfig(freshToken, {
              rootFolderId: folderId,
              rootFolderName: MY_DRIVE_TAB,
              updatedAt: Date.now(),
            });
            if (!saved) {
              void captureError({
                level: "warn",
                source: "useDrive",
                message:
                  "save-config-unsaved: app config was not persisted to Drive",
              });
            }
          } catch (err: unknown) {
            void captureError({
              level: "error",
              source: "useDrive",
              message: `save-config-failed: ${classifyError(err)}`,
            });
          }
        }
      } catch (e: unknown) {
        void captureError({
          level: "error",
          source: "useDrive",
          message: `root-select-cleanup-failed: ${classifyError(e)}`,
        });
      }
    },
    [
      setAppRootFolder,
      setCurrentFolderId,
      setCurrentFolderName,
      setFolderHistory,
    ],
  );

  return { handleSelectRootFolder };
};
