import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { recordFolderVisit } from "../utils/history";
import { getAppConfig, saveAppConfig } from "../utils/driveApi";
import { getValidToken } from "../utils/apiClient";

export const useDrive = (isLoggedIn: boolean, accessToken: string | null) => {
  // App Root Folder (Music Library Root)
  const [appRootFolder, setAppRootFolder] = useState<string | null>(null);

  // Current navigated folder
  const [currentFolderId, setCurrentFolderId] = useState("root");
  const [folderHistory, setFolderHistory] = useState<{ id: string, name: string }[]>([]);
  const [currentFolderName, setCurrentFolderName] = useState<string>("My Drive");
  const [sortOption, setSortOption] = useState<string>('name');

  useEffect(() => {
    const initApp = async () => {
      const savedSort = localStorage.getItem("drplay_sort_option");
      if (savedSort) {
        setSortOption(savedSort);
      }

      let localRoot = localStorage.getItem("drplay_root_folder");

      if (isLoggedIn && accessToken) {
        try {
          const freshToken = await getValidToken();
          if (freshToken) {
            const remoteConfig = await getAppConfig(freshToken);
            if (remoteConfig && remoteConfig.rootFolderId) {
              if (remoteConfig.rootFolderId !== localRoot) {
                localRoot = remoteConfig.rootFolderId;
              }
              const verifyUrl = `https://www.googleapis.com/drive/v3/files/${localRoot}?fields=id,name,driveId,mimeType`;
              const verifyRes = await fetch(verifyUrl, {
                headers: { Authorization: `Bearer ${freshToken}` }
              });
              if (!verifyRes.ok) {
                console.warn("Saved root folder no longer accessible, need re-select");
                localRoot = null;
              } else {
                const verifyData = await verifyRes.json();
                if (verifyData.mimeType !== 'application/vnd.google-apps.folder') {
                  console.warn("Saved root is not a folder, need re-select");
                  localRoot = null;
                } else if (verifyData.driveId) {
                  console.warn("Saved root is a Shared Drive folder, falling back to My Drive");
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
                } catch (e) {}
              }
            } else if (!localRoot) {
              localRoot = null;
            }
          } else {
            localRoot = null;
          }
        } catch (e) {
          console.error("Failed to sync config", e);
          localRoot = null;
        }
      }

      if (localRoot) {
        setAppRootFolder(localRoot);

        db.syncState.get("drplay_nav_state").then(state => {
          if (state && state.value) {
            setCurrentFolderId(state.value.id);
            setCurrentFolderName(state.value.id === 'root' ? "My Drive" : state.value.name);
            setFolderHistory(state.value.history || []);
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
                setFolderHistory([]);
              }
            } else {
              setCurrentFolderId(localRoot!);
              setCurrentFolderName("My Drive");
            }
          }
        }).catch(() => {
          setCurrentFolderId(localRoot!);
          setCurrentFolderName("My Drive");
        });
      } else {
        setAppRootFolder(null);
      }
    };
    
    initApp();
  }, [isLoggedIn, accessToken]);

  // Save folder navigation state whenever it changes
  useEffect(() => {
    if (isLoggedIn && appRootFolder) {
      db.syncState.put({
        key: "drplay_nav_state",
        value: {
          id: currentFolderId,
          name: currentFolderName,
          history: folderHistory
        }
      }).catch(e => console.error("Failed to save nav state", e));
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
        saveAppConfig(freshToken, { rootFolderId: folderId, rootFolderName: "My Drive", updatedAt: Date.now() });
      }
    } catch (e) {
      console.error("Failed to clear db or save config", e);
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
