import { useState, useEffect } from "react";
import { db } from "../db/db";
import { recordFolderVisit } from "../utils/history";

export const useDrive = (isLoggedIn: boolean) => {
  // App Root Folder (Music Library Root)
  const [appRootFolder, setAppRootFolder] = useState<string | null>(null);

  // Current navigated folder
  const [currentFolderId, setCurrentFolderId] = useState("root");
  const [folderHistory, setFolderHistory] = useState<{ id: string, name: string }[]>([]);
  const [currentFolderName, setCurrentFolderName] = useState<string>("My Drive");
  const [sortOption, setSortOption] = useState<string>('name');

  useEffect(() => {
    const savedRoot = localStorage.getItem("drplay_root_folder");
    const savedSort = localStorage.getItem("drplay_sort_option");
    if (savedSort) {
      setSortOption(savedSort);
    }

    if (savedRoot) {
      setAppRootFolder(savedRoot);

      db.syncState.get("drplay_nav_state").then(state => {
        if (state && state.value) {
          setCurrentFolderId(state.value.id);
          setCurrentFolderName(state.value.name);
          setFolderHistory(state.value.history || []);
        } else {
          // Fallback to old localStorage for backward compatibility
          const savedCurrentId = localStorage.getItem("drplay_current_folder_id");
          const savedCurrentName = localStorage.getItem("drplay_current_folder_name");
          const savedHistoryStr = localStorage.getItem("drplay_folder_history");

          if (savedCurrentId && savedCurrentName && savedHistoryStr) {
            setCurrentFolderId(savedCurrentId);
            setCurrentFolderName(savedCurrentName);
            try {
              setFolderHistory(JSON.parse(savedHistoryStr));
            } catch (e) {
              setFolderHistory([]);
            }
          } else {
            setCurrentFolderId(savedRoot);
          }
        }
      }).catch(() => setCurrentFolderId(savedRoot));
    }
  }, []);

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
    } catch (e) {
      console.error("Failed to clear db", e);
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
