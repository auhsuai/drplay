import { create } from 'zustand';
import { ROOT_FOLDER_ID, MY_DRIVE_TAB } from '../utils/driveConstants';

interface FolderHistoryItem {
  id: string;
  name: string;
}

interface DriveState {
  appRootFolder: string | null;
  currentFolderId: string;
  currentFolderName: string;
  folderHistory: FolderHistoryItem[];
  sortOption: string;
  isLoadingTracks: boolean;

  setAppRootFolder: (folderId: string | null) => void;
  setCurrentFolderId: (folderId: string) => void;
  setCurrentFolderName: (folderName: string) => void;
  setFolderHistory: (history: FolderHistoryItem[] | ((prev: FolderHistoryItem[]) => FolderHistoryItem[])) => void;
  setSortOption: (sortOption: string) => void;
  setIsLoadingTracks: (isLoading: boolean) => void;
}

// Drive root folder id lives in utils/driveConstants.ts (shared with the
// hooks and utils that touch the Drive API).

export const useDriveStore = create<DriveState>((set) => ({
  appRootFolder: null,
  currentFolderId: ROOT_FOLDER_ID,
  currentFolderName: MY_DRIVE_TAB,
  folderHistory: [],
  sortOption: 'name',
  // Loading starts TRUE so the first committed frame of My Drive is the
  // skeleton — useDriveExplorer turns it off once the folder fetch settles.
  // Starting false flashed the "no audio" empty state for one frame (RC-B).
  isLoadingTracks: true,

  setAppRootFolder: (appRootFolder) => set({ appRootFolder }),
  setCurrentFolderId: (currentFolderId) => set({ currentFolderId }),
  setCurrentFolderName: (currentFolderName) => set({ currentFolderName }),
  setFolderHistory: (history) => set((state) => ({ folderHistory: typeof history === 'function' ? history(state.folderHistory) : history })),
  setSortOption: (sortOption) => set({ sortOption }),
  setIsLoadingTracks: (isLoadingTracks) => set({ isLoadingTracks }),
}));
