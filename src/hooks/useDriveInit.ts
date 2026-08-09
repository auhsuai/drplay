import { useEffect } from "react";
import type { RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { getAppConfig, mergeWithTimeoutSignal } from "../utils/driveApi";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB } from "../utils/driveConstants";
import { authHeaders } from "../utils/driveFiles";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import {
  ROOT_FOLDER_KEY,
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  FOLDER_HISTORY_KEY,
  SORT_OPTION_KEY,
  DB_NAV_STATE_KEY,
} from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";

const ROOT_VERIFY_TIMEOUT_MS = 15_000;

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
        let savedSort: string | null = null;
        try {
          savedSort = localStorage.getItem(SORT_OPTION_KEY);
        } catch (err) {
          void captureError({
            level: "warn",
            source: "useDrive",
            message: `sort-option-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
          });
        }
        if (savedSort) {
          setSortOption(savedSort);
        }

        let localRoot: string | null = null;
        try {
          localRoot = localStorage.getItem(ROOT_FOLDER_KEY);
        } catch (err) {
          void captureError({
            level: "warn",
            source: "useDrive",
            message: `root-folder-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
          });
        }

        if (isLoggedIn && accessToken) {
          try {
            const freshToken = await getValidToken();
            if (isCancelled()) return;
            if (freshToken) {
              const remoteConfig = await getAppConfig(freshToken);
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
                const verifyUrl = `https://www.googleapis.com/drive/v3/files/${localRoot}?fields=id,name,driveId,mimeType`;
                const verifyRes = await fetchWithAuth(verifyUrl, {
                  headers: authHeaders(freshToken),
                  signal: mergeWithTimeoutSignal(
                    controller.signal,
                    ROOT_VERIFY_TIMEOUT_MS,
                  ),
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
                  if (
                    verifyData.mimeType !== "application/vnd.google-apps.folder"
                  ) {
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
                  let savedRoot: string | null = null;
                  try {
                    savedRoot = localStorage.getItem(ROOT_FOLDER_KEY);
                  } catch (err) {
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message: `root-folder-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                    });
                  }
                  if (remoteConfig.rootFolderId !== savedRoot) {
                    try {
                      localStorage.setItem(ROOT_FOLDER_KEY, localRoot);
                    } catch (err) {
                      void captureError({
                        level: "warn",
                        source: "useDrive",
                        message: `root-folder-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                      });
                    }
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
                    history: Array.isArray(obj.history)
                      ? obj.history.filter(
                          (x: unknown): x is { id: string; name: string } =>
                            typeof x === "object" &&
                            x !== null &&
                            typeof (x as Record<string, unknown>).id ===
                              "string",
                        )
                      : [],
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
              let savedCurrentId: string | null = null;
              try {
                savedCurrentId = localStorage.getItem(CURRENT_FOLDER_ID_KEY);
              } catch (err) {
                void captureError({
                  level: "warn",
                  source: "useDrive",
                  message: `current-folder-id-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                });
              }
              let savedCurrentName: string | null = null;
              try {
                savedCurrentName = localStorage.getItem(
                  CURRENT_FOLDER_NAME_KEY,
                );
              } catch (err) {
                void captureError({
                  level: "warn",
                  source: "useDrive",
                  message: `current-folder-name-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                });
              }
              let savedHistoryStr: string | null = null;
              try {
                savedHistoryStr = localStorage.getItem(FOLDER_HISTORY_KEY);
              } catch (err) {
                void captureError({
                  level: "warn",
                  source: "useDrive",
                  message: `folder-history-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                });
              }

              if (savedCurrentId && savedCurrentName && savedHistoryStr) {
                setCurrentFolderId(savedCurrentId);
                setCurrentFolderName(
                  savedCurrentId === ROOT_FOLDER_ID
                    ? MY_DRIVE_TAB
                    : savedCurrentName,
                );
                try {
                  setFolderHistory(
                    JSON.parse(savedHistoryStr) as {
                      id: string;
                      name: string;
                    }[],
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
