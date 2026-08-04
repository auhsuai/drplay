import { useRef, useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { recordFolderVisit } from "../utils/history";
import {
  getAppConfig,
  saveAppConfig,
  mergeWithTimeoutSignal,
} from "../utils/driveApi";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB } from "../utils/driveConstants";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import {
  ROOT_FOLDER_KEY,
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  FOLDER_HISTORY_KEY,
  SORT_OPTION_KEY,
} from "../utils/storageKeys";

const DB_NAV_STATE_KEY = "drplay_nav_state";
const ROOT_VERIFY_TIMEOUT_MS = 15_000;

const classifyError = (e: unknown): string =>
  e instanceof Error ? e.message : `[non-Error thrown] ${String(e)}`;

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
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
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
          captureError({
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
          captureError({
            level: "warn",
            source: "useDrive",
            message: `root-folder-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
          });
        }

        if (isLoggedIn && accessToken) {
          try {
            const freshToken = await getValidToken();
            if (cancelled) return;
            if (freshToken) {
              const remoteConfig = await getAppConfig(freshToken);
              if (cancelled) return;
              if (remoteConfig && remoteConfig.rootFolderId) {
                const rootId = String(remoteConfig.rootFolderId);
                if (rootId !== localRoot) {
                  localRoot = rootId;
                }
                const verifyUrl = `https://www.googleapis.com/drive/v3/files/${localRoot}?fields=id,name,driveId,mimeType`;
                const verifyRes = await fetchWithAuth(verifyUrl, {
                  headers: { Authorization: `Bearer ${freshToken}` },
                  signal: mergeWithTimeoutSignal(
                    controller.signal,
                    ROOT_VERIFY_TIMEOUT_MS,
                  ),
                });
                if (cancelled) return;
                if (!verifyRes.ok) {
                  captureError({
                    level: "warn",
                    source: "useDrive",
                    message:
                      "verify-root-inaccessible: saved root no longer accessible",
                  });
                  localRoot = null;
                } else {
                  const verifyData = await verifyRes.json();
                  if (
                    verifyData.mimeType !== "application/vnd.google-apps.folder"
                  ) {
                    captureError({
                      level: "warn",
                      source: "useDrive",
                      message:
                        "verify-root-not-folder: saved root is not a folder",
                    });
                    localRoot = null;
                  } else if (verifyData.driveId) {
                    captureError({
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
                    captureError({
                      level: "warn",
                      source: "useDrive",
                      message: `root-folder-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                    });
                  }
                  if (remoteConfig.rootFolderId !== savedRoot) {
                    try {
                      localStorage.setItem(ROOT_FOLDER_KEY, localRoot);
                    } catch (err) {
                      captureError({
                        level: "warn",
                        source: "useDrive",
                        message: `root-folder-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                      });
                    }
                  }
                  try {
                    await db.files.clear();
                    await invoke(CLEAR_LOCAL_CACHE_CMD);
                  } catch (e: unknown) {
                    captureError({
                      level: "warn",
                      source: "useDrive",
                      message: `clear-cache-failed: ${classifyError(e)}`,
                    });
                  }
                }
              } else if (!localRoot) {
                localRoot = null;
              }
            } else {
              localRoot = null;
            }
          } catch (e: unknown) {
            if (cancelled) return;
            captureError({
              level: "error",
              source: "useDrive",
              message: `sync-config-failed: ${classifyError(e)}`,
            });
            localRoot = null;
          }
        }

        if (cancelled) return;

        if (localRoot) {
          setAppRootFolder(localRoot);

          const fallbackToRoot = () => {
            setCurrentFolderId(localRoot);
            setCurrentFolderName(MY_DRIVE_TAB);
          };

          try {
            const state = await db.syncState.get(DB_NAV_STATE_KEY);
            if (cancelled) return;
            if (state && state.value) {
              const raw = state.value;
              if (raw && typeof raw === "object" && "id" in raw) {
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
                captureError({
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
                captureError({
                  level: "warn",
                  source: "useDrive",
                  message: `current-folder-name-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                });
              }
              let savedHistoryStr: string | null = null;
              try {
                savedHistoryStr = localStorage.getItem(FOLDER_HISTORY_KEY);
              } catch (err) {
                captureError({
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
                  setFolderHistory(JSON.parse(savedHistoryStr));
                } catch (e: unknown) {
                  captureError({
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
            if (cancelled) return;
            captureError({
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
        if (cancelled) return;
        captureError({
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
    initApp().catch((e) =>
      captureError({
        level: "error",
        source: "useDrive",
        message: `init-app-failed: ${classifyError(e)}`,
      }),
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isLoggedIn, accessToken, setSortOption]);

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
        .catch((e: unknown) =>
          captureError({
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
  ]);

  const handleOpenFolder = useCallback(
    (folderId: string, folderName: string) => {
      if (folderId === currentFolderId) return;
      setFolderHistory((prev) => [
        ...prev,
        { id: currentFolderId, name: currentFolderName },
      ]);
      setCurrentFolderId(folderId);
      setCurrentFolderName(folderName);
      recordFolderVisit(folderId, folderName);
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

  const handleSelectRootFolder = useCallback(
    async (folderId: string) => {
      try {
        localStorage.setItem(ROOT_FOLDER_KEY, folderId);
      } catch (err) {
        captureError({
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
              captureError({
                level: "warn",
                source: "useDrive",
                message:
                  "save-config-unsaved: app config was not persisted to Drive",
              });
            }
          } catch (err: unknown) {
            captureError({
              level: "error",
              source: "useDrive",
              message: `save-config-failed: ${classifyError(err)}`,
            });
          }
        }
      } catch (e: unknown) {
        captureError({
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
