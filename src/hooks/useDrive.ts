import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { recordFolderVisit } from "../utils/history";
import { getAppConfig, saveAppConfig } from "../utils/driveApi";
import { getValidToken } from "../utils/apiClient";

const DRIVE_MODULE = "useDrive";

// Standardize error context so every catch logs the module + subtype and never
// leaks the access token. Token values are never passed into these helpers.
const classifyError = (e: unknown): string =>
  e instanceof Error ? e.message : `[non-Error thrown] ${String(e)}`;

export const useDrive = (isLoggedIn: boolean, accessToken: string | null) => {
  // App Root Folder (Music Library Root)
  const [appRootFolder, setAppRootFolder] = useState<string | null>(null);

  // Current navigated folder
  const [currentFolderId, setCurrentFolderId] = useState("root");
  const [folderHistory, setFolderHistory] = useState<{ id: string, name: string }[]>([]);
  const [currentFolderName, setCurrentFolderName] = useState<string>("My Drive");
  const [sortOption, setSortOption] = useState<string>('name');

  // Gate the nav-state persistence effect until initApp has finished restoring.
  // Prevents the placeholder currentFolderId="root" (set before hydration) from
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
        const savedSort = localStorage.getItem("drplay_sort_option");
        if (savedSort) {
          setSortOption(savedSort);
        }

        let localRoot = localStorage.getItem("drplay_root_folder");

        if (isLoggedIn && accessToken) {
          try {
            const freshToken = await getValidToken();
            if (cancelled) return;
            if (freshToken) {
              const remoteConfig = await getAppConfig(freshToken);
              if (cancelled) return;
              if (remoteConfig && remoteConfig.rootFolderId) {
                if (remoteConfig.rootFolderId !== localRoot) {
                  localRoot = remoteConfig.rootFolderId;
                }
                const verifyUrl = `https://www.googleapis.com/drive/v3/files/${localRoot}?fields=id,name,driveId,mimeType`;
                const verifyRes = await fetch(verifyUrl, {
                  headers: { Authorization: `Bearer ${freshToken}` },
                  signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
                });
                if (cancelled) return;
                if (!verifyRes.ok) {
                  console.warn(`[${DRIVE_MODULE}] verify-root-inaccessible — saved root folder no longer accessible, need re-select`);
                  localRoot = null;
                } else {
                  const verifyData = await verifyRes.json();
                  if (verifyData.mimeType !== 'application/vnd.google-apps.folder') {
                    console.warn(`[${DRIVE_MODULE}] verify-root-not-folder — saved root is not a folder, need re-select`);
                    localRoot = null;
                  } else if (verifyData.driveId) {
                    console.warn(`[${DRIVE_MODULE}] verify-root-shared-drive — saved root is a Shared Drive folder, falling back to My Drive`);
                    localRoot = null;
                  }
                }
                if (localRoot) {
                  if (remoteConfig.rootFolderId !== localStorage.getItem("drplay_root_folder")) {
                    localStorage.setItem("drplay_root_folder", localRoot);
                  }
                  try {
                    await db.files.clear();
                    await invoke("clear_local_cache");
                  } catch (e) {
                    console.warn(`[${DRIVE_MODULE}] clear-cache-failed — failed to clear local cache on root folder change (best-effort)`, classifyError(e));
                  }
                }
              } else if (!localRoot) {
                localRoot = null;
              }
            } else {
              localRoot = null;
            }
          } catch (e) {
            if (cancelled) return;
            console.error(`[${DRIVE_MODULE}] sync-config-failed — failed to sync config (best-effort)`, classifyError(e));
            localRoot = null;
          }
        }

        if (cancelled) return;

        if (localRoot) {
          setAppRootFolder(localRoot);

          try {
            const state = await db.syncState.get("drplay_nav_state");
            if (cancelled) return;
            if (state && state.value) {
              const savedId = state.value.id;
              const suspectRoot = savedId === 'root' && localRoot !== 'root';
              const restoredId = suspectRoot ? localRoot! : savedId;
              setCurrentFolderId(restoredId);
              setCurrentFolderName(restoredId === localRoot || restoredId === 'root' ? "My Drive" : state.value.name);
              setFolderHistory(suspectRoot ? [] : (state.value.history || []));
            } else {
              const savedCurrentId = localStorage.getItem("drplay_current_folder_id");
              const savedCurrentName = localStorage.getItem("drplay_current_folder_name");
              const savedHistoryStr = localStorage.getItem("drplay_folder_history");

              if (savedCurrentId && savedCurrentName && savedHistoryStr) {
                setCurrentFolderId(savedCurrentId);
                setCurrentFolderName(savedCurrentId === 'root' ? "My Drive" : savedCurrentName);
                try {
                  setFolderHistory(JSON.parse(savedHistoryStr));
                } catch (e) {
                  // Silent before; now logged with context and falls back to [].
                  console.warn(`[${DRIVE_MODULE}] nav-state-parse — corrupt localStorage folder history, falling back to []`, classifyError(e));
                  setFolderHistory([]);
                }
              } else {
                setCurrentFolderId(localRoot!);
                setCurrentFolderName("My Drive");
              }
            }
          } catch (e) {
            if (cancelled) return;
            console.warn(`[${DRIVE_MODULE}] nav-state-restore-failed — failed to restore nav state, falling back to local root (best-effort)`, classifyError(e));
            setCurrentFolderId(localRoot!);
            setCurrentFolderName("My Drive");
          }
        } else {
          setAppRootFolder(null);
        }
      } catch (e) {
        // Unexpected throw from initApp (e.g. an unhandled rejection). Fall back
        // to a safe state so the app is not stuck without an app root folder and
        // hydration still completes in the finally below.
        if (cancelled) return;
        console.error(`[${DRIVE_MODULE}] init-app-unexpected — unexpected error during init, falling back to no root folder`, classifyError(e));
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
    initApp().catch(e => console.error(`[${DRIVE_MODULE}] init-app-failed`, classifyError(e)));

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isLoggedIn, accessToken]);

  // Save folder navigation state whenever it changes
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (isLoggedIn && appRootFolder) {
      db.syncState.put({
        key: "drplay_nav_state",
        value: {
          id: currentFolderId,
          name: currentFolderName,
          history: folderHistory
        }
      }).catch(e => console.error(`[${DRIVE_MODULE}] nav-state-save-failed`, classifyError(e)));
    }
  }, [currentFolderId, currentFolderName, folderHistory, isLoggedIn, appRootFolder]);

  const handleOpenFolder = (folderId: string, folderName: string) => {
    if (folderId === currentFolderId) return;
    setFolderHistory(prev => [...prev, { id: currentFolderId, name: currentFolderName }]);
    setCurrentFolderId(folderId);
    setCurrentFolderName(folderName);
    recordFolderVisit(folderId, folderName);
  };

  const handleBack = () => {
    if (folderHistory.length > 0) {
      const newHistory = [...folderHistory];
      const previousFolder = newHistory.pop();
      setFolderHistory(newHistory);
      setCurrentFolderId(previousFolder?.id || appRootFolder || "root");
      setCurrentFolderName(previousFolder?.name || "My Drive");
    }
  };

  const handleBreadcrumbClick = (id: string, name: string, index: number) => {
    const newHistory = folderHistory.slice(0, index);
    setFolderHistory(newHistory);
    setCurrentFolderId(id);
    setCurrentFolderName(name);
  };

  const handleSelectRootFolder = async (folderId: string) => {
    localStorage.setItem("drplay_root_folder", folderId);
    setAppRootFolder(folderId);
    setCurrentFolderId(folderId);
    setCurrentFolderName("My Drive");
    setFolderHistory([]);
    try {
      await db.files.clear();
      await invoke("clear_local_cache");
      const freshToken = await getValidToken();
      if (freshToken) {
        try {
          const saved = await saveAppConfig(freshToken, { rootFolderId: folderId, rootFolderName: "My Drive", updatedAt: Date.now() });
          if (!saved) {
            console.warn(`[${DRIVE_MODULE}] save-config-unsaved — app config was not persisted to Drive (save returned false), continuing with local root`);
          }
        } catch (err) {
          console.error(`[${DRIVE_MODULE}] save-config-failed — failed to save app config (best-effort)`, classifyError(err));
        }
      }
    } catch (e) {
      console.error(`[${DRIVE_MODULE}] root-select-cleanup-failed — failed to clear db or save config (best-effort)`, classifyError(e));
    }
  };

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
    handleSelectRootFolder
  };
};
