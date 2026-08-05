import { create } from "zustand";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB } from "../utils/driveConstants";

interface FolderHistoryItem {
  id: string;
  name: string;
}

interface DriveState {
  /** The folder the app was told to treat as its root (null = plain My Drive). */
  appRootFolder: string | null;
  /** The folder currently open in the explorer. */
  currentFolderId: string;
  /** Display name of the currently open folder (breadcrumb + list header). */
  currentFolderName: string;
  /** Breadcrumb trail: every folder visited from the root, in order. */
  folderHistory: FolderHistoryItem[];
  /** Active sort for the folder listing ("name", "modifiedTime desc", ...). */
  sortOption: string;
  /** True while the first page of a folder is still being fetched. */
  isLoadingTracks: boolean;

  /**
   * Pin the app root folder (user picks a folder to limit the library to).
   * @param folderId Drive folder id, or null to reset to plain My Drive.
   */
  setAppRootFolder: (folderId: string | null) => void;
  /** Open a different folder in the explorer. */
  setCurrentFolderId: (folderId: string) => void;
  /** Update the display name of the currently open folder. */
  setCurrentFolderName: (folderName: string) => void;
  /**
   * Replace the breadcrumb trail. Accepts a plain array or an updater that
   * receives the previous trail — used when navigating back a level.
   */
  setFolderHistory: (
    history:
      | FolderHistoryItem[]
      | ((prev: FolderHistoryItem[]) => FolderHistoryItem[]),
  ) => void;
  /** Change the sort option applied to the folder listing. */
  setSortOption: (sortOption: string) => void;
  /** Toggle the folder loading flag (skeleton vs. empty state). */
  setIsLoadingTracks: (isLoading: boolean) => void;
}

// Drive root folder id lives in utils/driveConstants.ts (shared with the
// hooks and utils that touch the Drive API).

/**
 * Global UI state for the Drive explorer: which folder is open, the
 * navigation history, the current sort option, and the loading flag that
 * decides whether My Drive shows a skeleton or the empty state. Components
 * read from this store so folder navigation is shared across the sidebar,
 * breadcrumbs and the main list without prop drilling.
 */
export const useDriveStore = create<DriveState>((set) => ({
  appRootFolder: null,
  currentFolderId: ROOT_FOLDER_ID,
  currentFolderName: MY_DRIVE_TAB,
  folderHistory: [],
  sortOption: "name",
  // Loading starts TRUE so the first committed frame of My Drive is the
  // skeleton — useDriveExplorer turns it off once the folder fetch settles.
  // Starting false flashed the "no audio" empty state for one frame (RC-B).
  isLoadingTracks: true,

  setAppRootFolder: (appRootFolder) => {
    set({ appRootFolder });
  },
  setCurrentFolderId: (currentFolderId) => {
    set({ currentFolderId });
  },
  setCurrentFolderName: (currentFolderName) => {
    set({ currentFolderName });
  },
  setFolderHistory: (history) => {
    set((state) => ({
      folderHistory:
        typeof history === "function" ? history(state.folderHistory) : history,
    }));
  },
  setSortOption: (sortOption) => {
    set({ sortOption });
  },
  setIsLoadingTracks: (isLoadingTracks) => {
    set({ isLoadingTracks });
  },
}));
