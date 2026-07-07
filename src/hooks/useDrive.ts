import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { recordFolderVisit } from "../utils/history";
import { getAppConfig, saveAppConfig } from "../utils/driveApi";

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
          const remoteConfig = await getAppConfig(accessToken);
          if (remoteConfig && remoteConfig.rootFolderId) {
            if (remoteConfig.rootFolderId !== localRoot) {
              localRoot = remoteConfig.rootFolderId;
              if (localRoot) {
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
        } catch (e) {
          console.error("Failed to sync config", e);
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
      if (accessToken) {
        saveAppConfig(accessToken, { rootFolderId: folderId, rootFolderName: "My Drive", updatedAt: Date.now() });
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
