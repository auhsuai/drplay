import { useCallback, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { t } from "i18next";
import { db } from "../db/db";
import { wipeFileRowsForUser } from "../db/fileRows";
import { getAppConfig, saveAppConfig } from "../utils/driveApi";
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
import { showErrorToast } from "../utils/simpleToast";
import {
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  DB_NAV_STATE_KEY,
  DEFAULT_USER_EMAIL,
  FOLDER_HISTORY_KEY,
  getCurrentUserEmail,
  ROOT_FOLDER_KEY,
  ROOT_FOLDERS_KEY,
  ROOT_FOLDERS_UPDATED_KEY,
  safeLocalStorageRemove,
  safeLocalStorageSet,
} from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";

// The exact document written to Drive. Kept so a failed cloud write can be
// retried later with the SAME payload/timestamp (never a freshly stamped one,
// which would silently supersede a newer remote config).
interface PendingRootConfig {
  rootFolderId: string;
  rootFolderName: string;
  rootFolders: RootFolder[];
  updatedAt: number;
}

export const useDriveRootSelector = () => {
  const {
    setAppRootFolder,
    setRootFolders,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setConfigError,
    setConfigSync,
  } = useDriveStore(
    useShallow((state) => ({
      setAppRootFolder: state.setAppRootFolder,
      setRootFolders: state.setRootFolders,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
      setConfigError: state.setConfigError,
      setConfigSync: state.setConfigSync,
    })),
  );

  // Last locally-applied commit whose cloud write was not confirmed.
  const pendingConfigRef = useRef<PendingRootConfig | null>(null);
  // Retries are user-triggered and must never overlap (two concurrent uploads
  // could interleave search/PATCH and produce a duplicate config file).
  const retryingRef = useRef(false);

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
      // ONE timestamp for both the local version marker and the cloud save, so
      // init can tell this commit apart from an older remote config.
      const committedAt = Date.now();
      // The exact document this commit wants in Drive. Kept for the whole
      // function so ANY path that skips the upload (cleanup failure, no token,
      // false/throw) leaves a retryable payload instead of losing the intent.
      const payload: PendingRootConfig = {
        rootFolderId: primary.id,
        rootFolderName: primary.name,
        rootFolders: committedRoots,
        updatedAt: committedAt,
      };
      pendingConfigRef.current = payload;

      safeLocalStorageSet(ROOT_FOLDER_KEY, primary.id, "root-folder-write");
      safeLocalStorageSet(
        ROOT_FOLDERS_KEY,
        JSON.stringify(committedRoots),
        "root-folders-write",
      );
      safeLocalStorageSet(
        ROOT_FOLDERS_UPDATED_KEY,
        String(committedAt),
        "root-folders-updated-write",
      );

      setRootFolders(committedRoots);
      setAppRootFolder(primary.id);
      setCurrentFolderId(isMulti ? VIRTUAL_ROOT_ID : primary.id);
      setCurrentFolderName(isMulti ? VIRTUAL_ROOT_NAME : MY_DRIVE_TAB);
      setFolderHistory([]);

      // The persisted nav snapshot points into the OLD root set. Drop it before
      // the await-heavy cache/cloud work so a crash or a concurrently-started
      // init cannot restore navigation from the previous roots.
      safeLocalStorageRemove(CURRENT_FOLDER_ID_KEY, "current-folder-id-remove");
      safeLocalStorageRemove(
        CURRENT_FOLDER_NAME_KEY,
        "current-folder-name-remove",
      );
      safeLocalStorageRemove(FOLDER_HISTORY_KEY, "folder-history-remove");
      try {
        await db.syncState.delete(DB_NAV_STATE_KEY);
      } catch (err: unknown) {
        // Best effort: failing to clear the snapshot must never abort a commit
        // the user already sees applied in memory/localStorage.
        void captureError({
          level: "warn",
          source: "useDrive",
          message: `commit-nav-state-clear-failed: ${classifyError(err)}`,
        });
      }

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
            const saved = await saveAppConfig(freshToken, payload);
            if (!saved) {
              // Local roots ARE applied (the user can work); only the cloud
              // write is unconfirmed, so the OTHER origin may still read the
              // previous document. Say so instead of implying success.
              void captureError({
                level: "warn",
                source: "useDrive",
                message:
                  "save-config-unsaved: app config was not persisted to Drive",
              });
              setConfigError(null);
              setConfigSync("unsaved");
              showErrorToast(t("folder_selection.roots_commit_failed"));
            } else {
              pendingConfigRef.current = null;
              setConfigError(null);
              setConfigSync("saved");
            }
          } catch (err: unknown) {
            void captureError({
              level: "error",
              source: "useDrive",
              message: `save-config-failed: ${classifyError(err)}`,
            });
            setConfigError(null);
            setConfigSync("unsaved");
            showErrorToast(t("folder_selection.roots_commit_failed"));
          }
        } else {
          // No usable token: the upload never happened. The payload stays
          // pending so a later retry can still land it, and the user is told
          // the truth (no success).
          void captureError({
            level: "warn",
            source: "useDrive",
            message: "save-config-unsaved: no valid token, app config unsent",
          });
          setConfigError(null);
          setConfigSync("unsaved");
          showErrorToast(t("folder_selection.roots_commit_failed"));
        }
      } catch (e: unknown) {
        void captureError({
          level: "error",
          source: "useDrive",
          message: `root-select-cleanup-failed: ${classifyError(e)}`,
        });
        // The cache/cloud stage aborted before the upload: the local commit
        // still stands, but Drive was never told. Keep the payload pending and
        // report a recoverable sync failure instead of implying success.
        setConfigError(null);
        setConfigSync("unsaved");
        showErrorToast(t("folder_selection.roots_commit_failed"));
      }
      return true;
    },
    [
      setAppRootFolder,
      setRootFolders,
      setCurrentFolderId,
      setCurrentFolderName,
      setFolderHistory,
      setConfigError,
      setConfigSync,
    ],
  );

  // Retry the unconfirmed cloud write with the EXACT payload of the last local
  // commit. Never invents a new timestamp: a fresher document could clobber a
  // newer remote config written by the other build.
  // @returns true when the remote already holds this state (or the upload
  // succeeded); false when nothing was retried or the write is still unsaved.
  const retryConfigSync = useCallback(async (): Promise<boolean> => {
    const pending = pendingConfigRef.current;
    if (pending === null) return false;
    // Single-flight: a second click must not run a concurrent read/upload.
    if (retryingRef.current) return false;
    retryingRef.current = true;
    try {
      const freshToken = await getValidToken();
      if (!freshToken) {
        void captureError({
          level: "warn",
          source: "useDrive",
          message: "config-retry-skipped-unavailable: no valid token",
        });
        setConfigSync("unsaved");
        return false;
      }
      const read = await getAppConfig(freshToken);
      if (read.status === "failed") {
        // The remote state is UNKNOWN: uploading now could overwrite a newer
        // config written by the other origin.
        void captureError({
          level: "warn",
          source: "useDrive",
          message: `config-retry-skipped-unavailable: ${read.reason}`,
        });
        setConfigSync("unsaved");
        return false;
      }
      if (read.status === "found") {
        const remoteUpdatedAt = read.config.updatedAt;
        if (
          typeof remoteUpdatedAt === "number" &&
          Number.isFinite(remoteUpdatedAt) &&
          remoteUpdatedAt > pending.updatedAt
        ) {
          // Someone else wrote a newer document: adopt it as the truth and
          // drop our stale pending payload instead of clobbering it.
          void captureError({
            level: "warn",
            source: "useDrive",
            message: "config-retry-superseded: remote config is newer",
          });
          pendingConfigRef.current = null;
          setConfigSync("saved");
          return true;
        }
      }
      // missing, or found-but-not-newer: our payload is still the latest
      // intent. saveAppConfig serialises through withSaveConfigLock.
      const saved = await saveAppConfig(freshToken, pending);
      if (saved) {
        pendingConfigRef.current = null;
        setConfigSync("saved");
      } else {
        setConfigSync("unsaved");
      }
      return saved;
    } catch (e: unknown) {
      void captureError({
        level: "error",
        source: "useDrive",
        message: `config-retry-failed: ${classifyError(e)}`,
      });
      setConfigSync("unsaved");
      return false;
    } finally {
      retryingRef.current = false;
    }
  }, [setConfigSync]);

  // Backward-compatible wrapper: a single root named "My Drive".
  const handleSelectRootFolder = useCallback(
    async (folderId: string) => {
      await commitRootFolders([{ id: folderId, name: MY_DRIVE_TAB }]);
    },
    [commitRootFolders],
  );

  return { commitRootFolders, handleSelectRootFolder, retryConfigSync };
};
