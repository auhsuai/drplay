import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { DEBUG_EVENTS, onDebugEvent } from "../ui/debug/debugEvents";
import { useDrive } from "./useDrive";
import { useDriveStore } from "../store/driveStore";
import { useLocateFile } from "./useLocateFile";
import type { TabKey } from "../types";

/**
 * App-level drive wiring: useDrive, the isLoadingTracks store slice, the
 * locate-file bridge, and the DEV-only SKELETON debug trigger — verbatim
 * from App.tsx.
 */
export function useAppDriveState(
  isLoggedIn: boolean,
  accessToken: string | null,
  setActiveTab: (tab: TabKey) => void,
) {
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
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
    handleSelectRootFolder,
  } = useDrive(isLoggedIn, accessToken);

  const { setIsLoadingTracks, isLoadingTracks } = useDriveStore(
    useShallow((s) => ({
      setIsLoadingTracks: s.setIsLoadingTracks,
      isLoadingTracks: s.isLoadingTracks,
    })),
  );

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Loading / MainContent"):
  // forces the My Drive skeleton through the same store flag useDrive flips
  // during a real folder fetch (App is the store owner; MainContent merely
  // receives the derived prop). Placed AFTER the useDriveStore destructure
  // above — the effect body must not touch a `const` declared later (TDZ).
  // Other SKELETON targets (trash/folders/home) are handled inside their own
  // views. onDebugEvent no-ops in production builds; the listener never runs
  // there.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.SKELETON, (detail) => {
      if (detail.target === "main-content") {
        setIsLoadingTracks(true);
      }
    });
  }, [setIsLoadingTracks]);

  // Locate File Logic
  const { highlightedFileId } = useLocateFile(
    accessToken,
    currentFolderId,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setActiveTab,
    setIsLoadingTracks,
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
    setIsLoadingTracks,
    isLoadingTracks,
    highlightedFileId,
  };
}
