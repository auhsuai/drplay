import React, { useState, useCallback, Suspense, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./ui/Sidebar/Sidebar";
import { NowPlayingView } from "./ui/NowPlaying/NowPlayingView";
import { PlayerBar } from "./ui/PlayerBar/PlayerBar";
import { FolderSelectionScreen } from "./ui/FolderSelection/FolderSelectionScreen";
import { TrashScreen } from "./ui/Settings/TrashScreen";
import { RateLimitModal } from "./ui/components/RateLimitModal";
import { captureError } from "./utils/errorLog";
import { useShallow } from 'zustand/react/shallow';

const MainContent = React.lazy(() => import('./ui/MainContent/MainContent').then(module => ({ default: module.MainContent })));
const HomeTab = React.lazy(() => import('./ui/HomeTab/HomeTab').then(module => ({ default: module.HomeTab })));
const LikedSongs = React.lazy(() => import('./ui/LikedSongs/LikedSongs').then(module => ({ default: module.LikedSongs })));
const PlaylistView = React.lazy(() => import('./ui/Playlist/PlaylistView').then(module => ({ default: module.PlaylistView })));
const SettingsTab = React.lazy(() => import('./ui/Settings/SettingsTab').then(module => ({ default: module.SettingsTab })));
import "./App.css";

import { db } from './db/db';
import { LoginScreen } from "./ui/Login/LoginScreen";
import { clearSessionState } from "./utils/sessionCleanup";

import { useAuth } from "./hooks/useAuth";
import { usePlayer } from "./hooks/usePlayer";
import { useDrive } from "./hooks/useDrive";
import { useTheme } from "./hooks/useTheme";

import { useServiceWorker } from "./hooks/useServiceWorker";
import { useAppGlobalEvents } from './hooks/useAppGlobalEvents';
import { useDriveStore } from './store/driveStore';
import { useTauriEvents } from "./hooks/useTauriEvents";
import { useLocateFile } from "./hooks/useLocateFile";

import type { Track, UserProfile } from './types';
export type { Track, UserProfile };

export type DriveItem = {
  id: string;
  title: string;
  isFolder: boolean;
  trackInfo?: Track;
  size?: number;
  modifiedTime?: string;
};

export type BreadcrumbItem = {
  id: string;
  name: string;
};




const LS_ROOT_FOLDER = 'drplay_root_folder';
const LS_CURRENT_FOLDER_ID = 'drplay_current_folder_id';
const LS_CURRENT_FOLDER_NAME = 'drplay_current_folder_name';
const LS_FOLDER_HISTORY = 'drplay_folder_history';
const LS_SORT_OPTION = 'drplay_sort_option';
const LS_MINIMIZE_TO_TRAY = 'drplay_minimize_to_tray';
const DB_NAV_STATE_KEY = 'drplay_nav_state';

function App() {
  const [activeTab, setActiveTab] = useState("Home");
  const { theme, setTheme } = useTheme();
  const [showTrashScreen, setShowTrashScreen] = useState(false);
  const [showRateLimitModal, setShowRateLimitModal] = useState(false);

  // Initialize service worker
  useServiceWorker();

  // Listen to Tauri events (Quota Exceeded, Repair Thumbnail)
  useTauriEvents(setShowRateLimitModal);

  const { isLoggedIn, accessToken, userProfile, handleLoginSuccess, handleLogout } = useAuth(() => {
    localStorage.removeItem(LS_ROOT_FOLDER);
    localStorage.removeItem(LS_CURRENT_FOLDER_ID);
    localStorage.removeItem(LS_CURRENT_FOLDER_NAME);
    localStorage.removeItem(LS_FOLDER_HISTORY);
    db.syncState.delete(DB_NAV_STATE_KEY).catch((e) => captureError({ source: 'App', message: `logout-cleanup-failed: ${e instanceof Error ? e.message : String(e)}`, kind: 'logout-cleanup-failed' }));
    clearSessionState();
    setAppRootFolder(null);
  });

  // Global window events (Focus, blur, contextmenu, auth-logout)
  useAppGlobalEvents(handleLogout);

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
    handleSelectRootFolder
  } = useDrive(isLoggedIn, accessToken);


  const { setIsLoadingTracks, isLoadingTracks } = useDriveStore(useShallow(s => ({
    setIsLoadingTracks: s.setIsLoadingTracks,
    isLoadingTracks: s.isLoadingTracks,
  })));
  // Locate File Logic
  const { highlightedFileId } = useLocateFile(
    accessToken,
    currentFolderId,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setActiveTab,
    setIsLoadingTracks
  );

  const {
    currentTrack,
    isPlaying,
    isDownloading,
    playMode,
    handlePlayTrack: playerPlayTrack,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlay,
    handleTogglePlayMode,
    loadNonce
  } = usePlayer(accessToken);

  const stableHandleTogglePlay = useCallback(handleTogglePlay, [handleTogglePlay]);
  const stableHandleNextTrack = useCallback(handleNextTrack, [handleNextTrack]);
  const stableHandlePrevTrack = useCallback(handlePrevTrack, [handlePrevTrack]);
  const stableHandleTogglePlayMode = useCallback(handleTogglePlayMode, [handleTogglePlayMode]);
  const onExpandNowPlaying = useCallback(() => {
    setIsNowPlayingOpen(prev => !prev);
  }, []);

  const handlePlayTrack = (track: Track, contextQueue?: Track[], isNavigation: boolean = false) => {
    playerPlayTrack(track, contextQueue, isNavigation, [], activeTab);
  };

  const [showFolderSelection, setShowFolderSelection] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(() => {
    const saved = localStorage.getItem(LS_MINIMIZE_TO_TRAY);
    return saved !== null ? saved === "true" : true;
  });

  useEffect(() => {
    localStorage.setItem(LS_MINIMIZE_TO_TRAY, String(minimizeToTray));
    invoke("update_minimize_to_tray", { minimize: minimizeToTray }).catch((e) => captureError({ source: 'App', message: `minimize-to-tray-failed: ${e instanceof Error ? e.message : String(e)}`, kind: 'minimize-to-tray-failed' }));
  }, [minimizeToTray]);

  const handleTabChange = useCallback((tab: string) => {
    if (activeTab === tab && tab === "My Drive") {
      setCurrentFolderId(appRootFolder || "root");
      setCurrentFolderName("My Drive");
      setFolderHistory([]);
    }
    setActiveTab(tab);
  }, [activeTab, appRootFolder, setCurrentFolderId, setCurrentFolderName, setFolderHistory]);

  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-white dark:bg-[#121212] transition-colors duration-300">
      {/* Login Overlay */}
      {!isLoggedIn && <LoginScreen onLogin={(token) => handleLoginSuccess({ access_token: token })} />}

      {/* Folder Selection Overlay */}
      {(isLoggedIn && (!appRootFolder || showFolderSelection)) && (
        <FolderSelectionScreen
          token={accessToken ?? ''}
          onSelectFolder={(folderId) => {
            handleSelectRootFolder(folderId);
            setShowFolderSelection(false);
          }}
          onCancel={appRootFolder ? () => setShowFolderSelection(false) : undefined}
          initialFolderId={'root'}
          initialFolderHistory={[]}
          allowEscapeRoot={true}
        />
      )}

      {showTrashScreen && accessToken && (
        <TrashScreen token={accessToken} onClose={() => setShowTrashScreen(false)} />
      )}

      <div className={`flex flex-1 overflow-hidden transition-all duration-700 ease-in-out ${(!isLoggedIn || (!appRootFolder && !showFolderSelection)) ? 'blur-xl scale-[0.97] opacity-40 pointer-events-none' : 'blur-0 scale-100 opacity-100'}`}>
        <Sidebar
          activeTab={activeTab}
          onTabChange={handleTabChange}
          userProfile={userProfile}
          onLogout={handleLogout}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        />

        <div id="content-area" className="flex-1 relative overflow-hidden flex flex-col">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-500">Loading...</div>}>
            {activeTab === "Home" ? (
              <HomeTab 
                onPlay={(t: Track, c?: Track[]) => handlePlayTrack(t, c)} 
                onOpenFolder={(id, name) => {
                  handleOpenFolder(id, name);
                  handleTabChange("My Drive");
                }}
                token={accessToken} 
                userProfile={userProfile} 
              />
            ) : activeTab === "My Drive" ? (
              <MainContent
                activeTab={activeTab}
                onPlay={handlePlayTrack}
                isLoading={isLoadingTracks}
                onOpenFolder={handleOpenFolder}
                onBack={handleBack}
                hasHistory={folderHistory.length > 0}
                folderHistory={folderHistory}
                currentFolderName={currentFolderName}
                currentFolderId={currentFolderId}
                onBreadcrumbClick={handleBreadcrumbClick}
                token={accessToken}
                highlightedFileId={highlightedFileId}
                onRefresh={() => { /* No-op, sync runs in background */ }}
                onRemoveItem={() => { /* useLiveQuery handles UI updates automatically now */ }}
                sortOption={sortOption}
                onSortChange={(val) => {
                  setSortOption(val);
                  localStorage.setItem(LS_SORT_OPTION, val);
                }}
              />
            ) : activeTab === "Liked Songs" ? (
              <LikedSongs onPlay={(t: Track, c: Track[]) => { handlePlayTrack(t, c); }} token={accessToken} currentTrack={currentTrack} />
            ) : activeTab.startsWith("playlist_") ? (
              <PlaylistView
                playlistId={activeTab.replace("playlist_", "")}
                onPlay={(t: Track, c?: Track[]) => { handlePlayTrack(t, c); }}
                onDelete={() => handleTabChange("Home")}
                currentTrack={currentTrack}
              />
            ) : activeTab === "Settings" ? (
              <SettingsTab
                theme={theme}
                setTheme={setTheme}
                minimizeToTray={minimizeToTray}
                setMinimizeToTray={setMinimizeToTray}
                setShowFolderSelection={setShowFolderSelection}
                setShowTrashScreen={setShowTrashScreen}
              />
            ) : (
              <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto flex items-center justify-center transition-colors duration-300">
                <h1 className="text-2xl text-gray-500">Coming Soon: {activeTab}</h1>
              </main>
            )}
          </Suspense>

          <div className={`transition-all duration-700 ease-in-out shrink-0 ${isNowPlayingOpen ? 'h-0 overflow-hidden pointer-events-none opacity-0' : ''}`}>
            <PlayerBar
              currentTrack={currentTrack}
              loadNonce={loadNonce}
              isPlaying={isPlaying}
              onTogglePlay={stableHandleTogglePlay}
              onNextTrack={stableHandleNextTrack}
              onPrevTrack={stableHandlePrevTrack}
              isDownloading={isDownloading}
              playMode={playMode}
              onTogglePlayMode={stableHandleTogglePlayMode}
              onExpandNowPlaying={onExpandNowPlaying}
            />
          </div>
        </div>
      </div>
      
      {/* Now Playing Full Screen Overlay */}
      <div
        className={`fixed inset-0 z-[9999] bg-white dark:bg-[#121212] flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${isNowPlayingOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none'
          }`}
      >
        <NowPlayingView
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          onTogglePlay={stableHandleTogglePlay}
          onNextTrack={stableHandleNextTrack}
          onPrevTrack={stableHandlePrevTrack}
          playMode={playMode}
          onTogglePlayMode={stableHandleTogglePlayMode}
          onBack={() => setIsNowPlayingOpen(false)}
          isOpen={isNowPlayingOpen}
          token={accessToken}
        />
      </div>
      
      <RateLimitModal 
        isOpen={showRateLimitModal}
        onClose={() => setShowRateLimitModal(false)}
        onOk={() => {
          setShowRateLimitModal(false);
          handleTabChange("Home");
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />

      {/* Toast container: simpleToast appends here; must stay mounted for the
          app's whole lifetime so showErrorToast/showSuccessToast work everywhere */}
      <div id="toast-root" />
    </div>
  );
}

export default App;
