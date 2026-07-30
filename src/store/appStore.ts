import { create } from 'zustand';

interface AppState {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  showFolderSelection: boolean;
  setShowFolderSelection: (show: boolean) => void;
  isSidebarOpen: boolean;
  setIsSidebarOpen: (isOpen: boolean) => void;
  isNowPlayingOpen: boolean;
  setIsNowPlayingOpen: (isOpen: boolean | ((prev: boolean) => boolean)) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: 'Home',
  setActiveTab: (activeTab) => set({ activeTab }),
  showFolderSelection: false,
  setShowFolderSelection: (showFolderSelection) => set({ showFolderSelection }),
  isSidebarOpen: false,
  setIsSidebarOpen: (isSidebarOpen) => set({ isSidebarOpen }),
  isNowPlayingOpen: false,
  setIsNowPlayingOpen: (isOpen) => set((state) => ({ isNowPlayingOpen: typeof isOpen === 'function' ? isOpen(state.isNowPlayingOpen) : isOpen })),
}));
