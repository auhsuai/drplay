import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { getAppConfig, FOLDER_MIME } from "../utils/driveApi";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB } from "../utils/driveConstants";
import { authHeaders, DRIVE_FILES_URL } from "../utils/driveFiles";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import {
  ROOT_FOLDER_KEY,
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  FOLDER_HISTORY_KEY,
  SORT_OPTION_KEY,
  DB_NAV_STATE_KEY,
  safeLocalStorageGet,
  safeLocalStorageSet,
} from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";

// Validates the persisted folder-history shape the same way the Dexie branch
// does: an entry survives only when it is an object with a string `id`. The
// type predicate narrows `name` as string even though runtime only checks
// `id` — identical to the inline filter it replaces.
function parseNavHistory(value: unknown): { id: string; name: string }[] {
  return Array.isArray(value)
    ? value.filter(
        (x: unknown): x is { id: string; name: string } =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as Record<string, unknown>).id === "string",
      )
    : [];
}

interface UseDriveInitParams {
  accessToken: string | null;
  isLoggedIn: boolean;
  hydratedRef: RefObject<boolean>;
}

export const useDriveInit = ({
  accessToken,
  isLoggedIn,
  hydratedRef,
}: UseDriveInitParams) => {
  // Nav restore runs EXACTLY once per session: the first time a root folder is
  // established (the initial hydrate). useDriveInit's effect also re-runs on
  // every accessToken change (Android proactive token refresh now succeeds),
  // and a re-run must NOT re-apply the persisted folder — the user may have
  // navigated meanwhile, and restoring would yank them back to the folder that
  // was open at app launch. Everything else initApp does (config re-verify,
  // root check, cache clear on root change) still runs on every re-init.
  const hasRestoredNavRef = useRef(false);

  const {
    setAppRootFolder,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setSortOption,
  } = useDriveStore(
    useShallow((state) => ({
      setAppRootFolder: state.setAppRootFolder,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
      setSortOption: state.setSortOption,
    })),
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const isCancelled = () => cancelled;
    hydratedRef.current = false;

    const initApp = async () => {
      // Outer try/finally guarantees hydration always reaches a safe state.
      // Even if initApp throws unexpectedly, the `finally` flips hydratedRef
      // true (unless the effect was cleaned up) so the nav-state save effect is
      // never permanently disabled. Without this, a rejected initApp would leave
      // hydratedRef.current=false forever and the app would silently stop
      // persisting navigation state.
      try {
        const savedSort = safeLocalStorageGet(
          SORT_OPTION_KEY,
          "sort-option-read",
        );
        if (savedSort) {
          setSortOption(savedSort);
        }

        let localRoot = safeLocalStorageGet(
          ROOT_FOLDER_KEY,
          "root-folder-read",
        );

        if (isLoggedIn && accessToken) {
          try {
            const freshToken = await getValidToken();
            if (isCancelled()) return;
            if (freshToken) {
              const remoteConfig = await getAppConfig(
                freshToken,
                controller.signal,
              );
              if (isCancelled()) return;
              if (remoteConfig && remoteConfig.rootFolderId) {
                // The config id is a Drive file id (string) by contract; the
                // typeof guard keeps String() off a truthy-narrowed value.
                const rootIdRaw: unknown = remoteConfig.rootFolderId;
                const rootId =
                  typeof rootIdRaw === "string" ? rootIdRaw : String(rootIdRaw);
                if (rootId !== localRoot) {
                  localRoot = rootId;
                }
                const verifyUrl = `${DRIVE_FILES_URL}/${localRoot}?fields=id,name,driveId,mimeType`;
                const verifyRes = await fetchWithAuth(verifyUrl, {
                  headers: authHeaders(freshToken),
                  // Timeout is guaranteed by fetchWithAuth itself (15s default
                  // merged with the caller signal via AbortSignal.any).
                  signal: controller.signal,
                });
                if (isCancelled()) return;
                if (!verifyRes.ok) {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message:
                      "verify-root-inaccessible: saved root no longer accessible",
                  });
                  localRoot = null;
                } else {
                  const verifyData = (await verifyRes.json()) as {
                    mimeType?: unknown;
                    driveId?: unknown;
                  };
                  if (verifyData.mimeType !== FOLDER_MIME) {
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message:
                        "verify-root-not-folder: saved root is not a folder",
                    });
                    localRoot = null;
                  } else if (verifyData.driveId) {
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message:
                        "verify-root-shared-drive: saved root is a Shared Drive folder",
                    });
                    localRoot = null;
                  }
                }
                if (localRoot) {
                  const savedRoot = safeLocalStorageGet(
                    ROOT_FOLDER_KEY,
                    "root-folder-read",
                  );
                  if (remoteConfig.rootFolderId !== savedRoot) {
                    safeLocalStorageSet(
                      ROOT_FOLDER_KEY,
                      localRoot,
                      "root-folder-write",
                    );
                    // Invalidate the local listing only when the configured
                    // root actually changed. initApp also re-runs on a plain
                    // proactive token refresh; wiping db.files then would
                    // blank the My Drive UI until the next folder fetch.
                    try {
                      await db.files.clear();
                      await invoke(CLEAR_LOCAL_CACHE_CMD);
                    } catch (e: unknown) {
                      void captureError({
                        level: "warn",
                        source: "useDrive",
                        message: `clear-cache-failed: ${classifyError(e)}`,
                      });
                    }
                  }
                }
              } else if (!localRoot) {
                localRoot = null;
              }
            } else {
              localRoot = null;
            }
          } catch (e: unknown) {
            if (isCancelled()) return;
            void captureError({
              level: "error",
              source: "useDrive",
              message: `sync-config-failed: ${classifyError(e)}`,
            });
            localRoot = null;
          }
        }

        if (isCancelled()) return;

        if (localRoot) {
          setAppRootFolder(localRoot);

          if (hasRestoredNavRef.current) {
            return;
          }

          const fallbackToRoot = () => {
            setCurrentFolderId(localRoot);
            setCurrentFolderName(MY_DRIVE_TAB);
          };

          try {
            const state = await db.syncState.get(DB_NAV_STATE_KEY);
            if (isCancelled()) return;
            if (state && state.value) {
              const raw = state.value;
              if (typeof raw === "object" && "id" in raw) {
                const obj = raw as Record<string, unknown>;
                if (typeof obj.id === "string") {
                  const sv = {
                    id: obj.id,
                    name:
                      typeof obj.name === "string" ? obj.name : MY_DRIVE_TAB,
                    history: parseNavHistory(obj.history),
                  };
                  const savedId = sv.id;
                  const suspectRoot =
                    savedId === ROOT_FOLDER_ID && localRoot !== ROOT_FOLDER_ID;
                  const restoredId =
                    suspectRoot && localRoot ? localRoot : savedId;
                  setCurrentFolderId(restoredId);
                  setCurrentFolderName(
                    restoredId === localRoot || restoredId === ROOT_FOLDER_ID
                      ? MY_DRIVE_TAB
                      : sv.name,
                  );
                  setFolderHistory(suspectRoot ? [] : sv.history);
                } else {
                  fallbackToRoot();
                }
              } else {
                fallbackToRoot();
              }
            } else {
              const savedCurrentId = safeLocalStorageGet(
                CURRENT_FOLDER_ID_KEY,
                "current-folder-id-read",
              );
              const savedCurrentName = safeLocalStorageGet(
                CURRENT_FOLDER_NAME_KEY,
                "current-folder-name-read",
              );
              const savedHistoryStr = safeLocalStorageGet(
                FOLDER_HISTORY_KEY,
                "folder-history-read",
              );

              if (savedCurrentId && savedCurrentName && savedHistoryStr) {
                setCurrentFolderId(savedCurrentId);
                setCurrentFolderName(
                  savedCurrentId === ROOT_FOLDER_ID
                    ? MY_DRIVE_TAB
                    : savedCurrentName,
                );
                try {
                  setFolderHistory(
                    parseNavHistory(JSON.parse(savedHistoryStr)),
                  );
                } catch (e: unknown) {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `nav-state-parse: corrupt localStorage folder history, ${classifyError(e)}`,
                  });
                  setFolderHistory([]);
                }
              } else {
                fallbackToRoot();
              }
            }
          } catch (e: unknown) {
            if (isCancelled()) return;
            void captureError({
              level: "warn",
              source: "useDrive",
              message: `nav-state-restore-failed: ${classifyError(e)}`,
            });
            fallbackToRoot();
          }

          // Consume the once-per-session flag ONLY after the restore block
          // finished without cancellation. A run cancelled mid-restore
          // (StrictMode remount / auth flip on cold start) must not burn the
          // flag, otherwise the next run skips the restore entirely and the
          // persisted nav state is lost for the whole session.
          if (isCancelled()) return;
          hasRestoredNavRef.current = true;
        } else {
          setAppRootFolder(null);
        }
      } catch (e: unknown) {
        // Unexpected throw from initApp (e.g. an unhandled rejection). Fall back
        // to a safe state so the app is not stuck without an app root folder and
        // hydration still completes in the finally below.
        if (isCancelled()) return;
        void captureError({
          level: "error",
          source: "useDrive",
          message: `init-app-unexpected: ${classifyError(e)}`,
        });
        setAppRootFolder(null);
      } finally {
        // Hydration safety: always flip to true unless the effect was cleaned up
        // (unmount / dependency change). If cancelled, a fresh effect run will
        // re-init with hydratedRef reset to false, so we must NOT hydrate here.
        if (!cancelled) {
          hydratedRef.current = true;
        }
      }
    };

    // Defensive net: initApp's own try/finally already guarantees hydration, but
    // this catch logs any rejection that escapes initApp instead of swallowing it.
    initApp().catch(
      (e: unknown) =>
        void captureError({
          level: "error",
          source: "useDrive",
          message: `init-app-failed: ${classifyError(e)}`,
        }),
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    isLoggedIn,
    accessToken,
    setSortOption,
    setAppRootFolder,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
  ]);
};
