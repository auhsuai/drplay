import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { wipeFileRowsForUser } from "../db/fileRows";
import { saveAppConfig } from "../utils/driveApi";
import { getValidToken } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import {
  MY_DRIVE_TAB,
  VIRTUAL_ROOT_ID,
  VIRTUAL_ROOT_NAME,
} from "../utils/driveConstants";
import { parseRootFolders, type RootFolder } from "../utils/rootFolders";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import {
  DEFAULT_USER_EMAIL,
  getCurrentUserEmail,
  ROOT_FOLDER_KEY,
  ROOT_FOLDERS_KEY,
  safeLocalStorageSet,
} from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";

export const useDriveRootSelector = () => {
  const {
    setAppRootFolder,
    setRootFolders,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
  } = useDriveStore(
    useShallow((state) => ({
      setAppRootFolder: state.setAppRootFolder,
      setRootFolders: state.setRootFolders,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
    })),
  );

  // Single write path for the whole ordered root list. Applies localStorage +
  // in-memory state first (so the session is usable even when Drive is
  // unreachable), then invalidates the account-scoped mirror and saves ONE
  // config document. An invalid list is rejected before touching anything.
  const commitRootFolders = useCallback(
    async (roots: RootFolder[]): Promise<boolean> => {
      const parsed = parseRootFolders(roots);
      if (parsed === null) {
        void captureError({
          level: "error",
          source: "useDrive",
          message: "commit-roots-invalid: root folder list rejected by parser",
        });
        return false;
      }

      const [primary, ...rest] = parsed;
      if (primary === undefined) {
        void captureError({
          level: "error",
          source: "useDrive",
          message: "commit-roots-invalid: empty root folder list",
        });
        return false;
      }
      const isMulti = rest.length > 0;
      // Copy so later store consumers cannot mutate the committed snapshot.
      const committedRoots = parsed.map((root) => ({ ...root }));

      safeLocalStorageSet(ROOT_FOLDER_KEY, primary.id, "root-folder-write");
      safeLocalStorageSet(
        ROOT_FOLDERS_KEY,
        JSON.stringify(committedRoots),
        "root-folders-write",
      );

      setRootFolders(committedRoots);
      setAppRootFolder(primary.id);
      setCurrentFolderId(isMulti ? VIRTUAL_ROOT_ID : primary.id);
      setCurrentFolderName(isMulti ? VIRTUAL_ROOT_NAME : MY_DRIVE_TAB);
      setFolderHistory([]);

      try {
        const email = getCurrentUserEmail();
        if (email === DEFAULT_USER_EMAIL) {
          // Sentinel owner (no real account email known yet): legacy rows have
          // no account fingerprint to scope by — keep the store-wide clear.
          await db.files.clear();
        } else {
          // Account-scoped invalidation (schema v10 scoping): a store-wide
          // clear would destroy every OTHER account's mirror too.
          await wipeFileRowsForUser(email);
        }
        await invoke(CLEAR_LOCAL_CACHE_CMD);
        const freshToken = await getValidToken();
        if (freshToken) {
          try {
            const saved = await saveAppConfig(freshToken, {
              rootFolderId: primary.id,
              rootFolderName: primary.name,
              rootFolders: committedRoots,
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
      return true;
    },
    [
      setAppRootFolder,
      setRootFolders,
      setCurrentFolderId,
      setCurrentFolderName,
      setFolderHistory,
    ],
  );

  // Backward-compatible wrapper: a single root named "My Drive".
  const handleSelectRootFolder = useCallback(
    async (folderId: string) => {
      await commitRootFolders([{ id: folderId, name: MY_DRIVE_TAB }]);
    },
    [commitRootFolders],
  );

  return { commitRootFolders, handleSelectRootFolder };
};
