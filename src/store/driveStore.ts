import { create } from 'zustand';

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

export const useDriveStore = create<DriveState>((set) => ({
  appRootFolder: null,
  currentFolderId: 'root',
  currentFolderName: 'My Drive',
  folderHistory: [],
  sortOption: 'name',
  isLoadingTracks: false,

  setAppRootFolder: (appRootFolder) => set({ appRootFolder }),
  setCurrentFolderId: (currentFolderId) => set({ currentFolderId }),
  setCurrentFolderName: (currentFolderName) => set({ currentFolderName }),
  setFolderHistory: (history) => set((state) => ({ folderHistory: typeof history === 'function' ? history(state.folderHistory) : history })),
  setSortOption: (sortOption) => set({ sortOption }),
  setIsLoadingTracks: (isLoadingTracks) => set({ isLoadingTracks }),
}));
