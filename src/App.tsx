import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./ui/Sidebar/Sidebar";
import { PlayerBar } from "./ui/PlayerBar/PlayerBar";
import { FolderSelectionScreen } from "./ui/FolderSelection/FolderSelectionScreen";
import { TrashScreen } from "./ui/Settings/TrashScreen";
import React, { Suspense } from "react";

const MainContent = React.lazy(() => import('./ui/MainContent/MainContent').then(m => ({ default: m.MainContent })));
const HomeTab = React.lazy(() => import('./ui/HomeTab/HomeTab').then(m => ({ default: m.HomeTab })));
const LikedSongs = React.lazy(() => import('./ui/LikedSongs/LikedSongs').then(m => ({ default: m.LikedSongs })));
const PlaylistView = React.lazy(() => import('./ui/Playlist/PlaylistView').then(m => ({ default: m.PlaylistView })));
const SettingsTab = React.lazy(() => import('./ui/Settings/SettingsTab').then(m => ({ default: m.SettingsTab })));
import "./App.css";
import { db } from './db/db';
import { del as kvDel } from './db/kv';
import { useLiveQuery } from 'dexie-react-hooks';
import { LoginScreen } from "./ui/Login/LoginScreen";

import { getValidToken } from "./utils/apiClient";
import { getAccessToken } from "./utils/tokenStore";
import { sortDriveItems } from "./utils/sortDriveItems";
import { fetchFolderContents } from "./utils/fetchFolderContents";
import { useAuth } from "./hooks/useAuth";
import { usePlayer } from "./hooks/usePlayer";
import { useDrive } from "./hooks/useDrive";
import { useTheme } from "./hooks/useTheme";
import { useLocateFile } from "./hooks/useLocateFile";

export type Track = {
  id: string; title: string; artist: string; streamUrl: string;
  size?: number; originalName?: string; restoreTime?: number;
  restoreDuration?: number; parentId?: string; parentName?: string; queueItemId?: string;
};
export type DriveItem = {
  id: string; title: string; isFolder: boolean;
  trackInfo?: Track; size?: number; modifiedTime?: string;
};
export type BreadcrumbItem = { id: string; name: string };
export type UserProfile = { name: string; email: string; picture: string };

function App() {
  const [activeTab, setActiveTab] = useState("Home");
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const { theme, setTheme } = useTheme();
  const [showTrashScreen, setShowTrashScreen] = useState(false);
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    const handleFocus = () => {
      setIsFocused(true);
      // getAccessToken() (in-memory, see utils/tokenStore.ts) is a reasonable
      // proxy for "we have an active session" -- getValidToken() itself
      // handles the actual expiry/refresh-token lookup safely either way.
      if (getAccessToken())
        getValidToken().catch(e => console.warn("[Auth] Focus refresh failed", e));
    };
    const handleBlur = () => setIsFocused(false);
    const preventContext = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener('contextmenu', preventContext);
    setIsFocused(document.hasFocus());
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener('contextmenu', preventContext);
    };
  }, []);

  const { isLoggedIn, accessToken, userProfile, handleLoginSuccess, handleLogout } = useAuth(() => {
    localStorage.removeItem("drplay_root_folder");
    db.syncState.delete("drplay_nav_state").catch(() => {});
    kvDel('drplay_last_session').catch(() => {});
    setAppRootFolder(null);
  });

  const {
    appRootFolder, setAppRootFolder, currentFolderId, setCurrentFolderId,
    currentFolderName, setCurrentFolderName, folderHistory, setFolderHistory,
    sortOption, setSortOption, handleOpenFolder, handleBack, handleBreadcrumbClick,
    handleSelectRootFolder,
  } = useDrive(isLoggedIn, accessToken);

  const { currentTrack, isPlaying, isDownloading, playMode,
    handlePlayTrack: playerPlayTrack, handleNextTrack, handlePrevTrack,
    handleTogglePlay, handleTogglePlayMode, loadNonce } = usePlayer(accessToken);

  const dbFiles = useLiveQuery(
    () => currentFolderId ? db.files.where('parentId').equals(currentFolderId).toArray() : Promise.resolve([] as any[]),
    [currentFolderId]
  );
  const driveItems = useMemo(
    () => dbFiles ? sortDriveItems(dbFiles, sortOption, currentFolderName) : [],
    [dbFiles, sortOption, currentFolderName]
  );

  const handlePlayTrack = (track: Track, contextQueue?: Track[], isNavigation = false) =>
    playerPlayTrack(track, contextQueue, isNavigation, driveItems, activeTab);

  const [showFolderSelection, setShowFolderSelection] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [highlightedFileId, setHighlightedFileId] = useState<{ id: string; ts: number } | null>(null);
  const [minimizeToTray, setMinimizeToTray] = useState(() => localStorage.getItem("drplay_minimize_to_tray") !== "false");
  useEffect(() => {
    localStorage.setItem("drplay_minimize_to_tray", String(minimizeToTray));
    invoke("update_minimize_to_tray", { minimize: minimizeToTray }).catch(() => {});
  }, [minimizeToTray]);

  useLocateFile({
    accessToken, currentFolderId, setActiveTab, setIsLoadingTracks,
    setFolderHistory, setCurrentFolderId, setCurrentFolderName, setHighlightedFileId,
  });

  useEffect(() => {
    const handler = () => handleLogout();
    window.addEventListener('auth-logout', handler);
    return () => window.removeEventListener('auth-logout', handler);
  }, []);

  useEffect(() => {
    const handler = () => {
      if (isLoggedIn && accessToken && currentFolderId)
        fetchFolderContents(accessToken, currentFolderId, sortOption, () => setIsLoadingTracks(true), () => setIsLoadingTracks(false));
    };
    window.addEventListener('refresh-drive', handler);
    return () => window.removeEventListener('refresh-drive', handler);
  }, [isLoggedIn, accessToken, currentFolderId, sortOption]);

  useEffect(() => {
    if (isLoggedIn && accessToken && currentFolderId)
      fetchFolderContents(accessToken, currentFolderId, sortOption, () => setIsLoadingTracks(true), () => setIsLoadingTracks(false));
  }, [isLoggedIn, accessToken, currentFolderId]);

  useEffect(() => {
    const handler = () => setIsLoadingTracks(false);
    window.addEventListener('pro-sync-complete', handler);
    window.addEventListener('pro-sync-error', handler);
    return () => {
      window.removeEventListener('pro-sync-complete', handler);
      window.removeEventListener('pro-sync-error', handler);
    };
  }, []);

  const handleTabChange = useCallback((tab: string) => {
    if (activeTab === tab && tab === "My Drive") {
      setCurrentFolderId(appRootFolder || "root");
      setCurrentFolderName("My Drive");
      setFolderHistory([]);
    }
    setActiveTab(tab);
  }, [activeTab, appRootFolder]);

  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-white dark:bg-[#121212] transition-colors duration-300">
      {!isLoggedIn && <LoginScreen onLogin={handleLoginSuccess} />}
      {(isLoggedIn && (!appRootFolder || showFolderSelection)) && (
        <FolderSelectionScreen token={accessToken!}
          onSelectFolder={(id) => { handleSelectRootFolder(id); setShowFolderSelection(false); }}
          onCancel={appRootFolder ? () => setShowFolderSelection(false) : undefined}
          initialFolderId="root" initialFolderHistory={[]} allowEscapeRoot />
      )}
      {showTrashScreen && accessToken && <TrashScreen token={accessToken} onClose={() => setShowTrashScreen(false)} />}

      <div className={`flex flex-1 overflow-hidden transition-all duration-700 ease-in-out ${(!isLoggedIn || (!appRootFolder && !showFolderSelection)) ? 'blur-xl scale-[0.97] opacity-40 pointer-events-none' : 'blur-0 scale-100 opacity-100'}`}>
        <Sidebar activeTab={activeTab} onTabChange={handleTabChange} userProfile={userProfile}
          onLogout={handleLogout} isSidebarOpen={isSidebarOpen} onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} />
        <div id="content-area" className="flex-1 relative overflow-hidden flex flex-col">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-500">Loading...</div>}>
            {activeTab === "Home" ? (
              <HomeTab onPlay={(t, c) => handlePlayTrack(t, c)} onOpenFolder={(id, name) => { handleOpenFolder(id, name); handleTabChange("My Drive"); }} token={accessToken} userProfile={userProfile} />
            ) : activeTab === "My Drive" ? (
              <MainContent activeTab={activeTab} onPlay={(t, c) => handlePlayTrack(t, c)} currentTrack={currentTrack} items={driveItems} isLoading={isLoadingTracks} onOpenFolder={handleOpenFolder} onBack={handleBack} hasHistory={folderHistory.length > 0} folderHistory={folderHistory} currentFolderName={currentFolderName} currentFolderId={currentFolderId} onBreadcrumbClick={handleBreadcrumbClick} token={accessToken} highlightedFileId={highlightedFileId} onRefresh={() => {}} onRemoveItem={() => {}} sortOption={sortOption} onSortChange={v => { setSortOption(v); localStorage.setItem("drplay_sort_option", v); }} />
            ) : activeTab === "Liked Songs" ? (
              <LikedSongs onPlay={(t, c) => handlePlayTrack(t, c)} currentTrack={currentTrack} />
            ) : activeTab.startsWith("playlist_") ? (
              <PlaylistView playlistId={activeTab.replace("playlist_", "")} onPlay={(t, c) => handlePlayTrack(t, c)} onDelete={() => handleTabChange("Home")} currentTrack={currentTrack} />
            ) : activeTab === "Settings" ? (
              <SettingsTab theme={theme} setTheme={setTheme} minimizeToTray={minimizeToTray} setMinimizeToTray={setMinimizeToTray} setShowFolderSelection={setShowFolderSelection} setShowTrashScreen={setShowTrashScreen} />
            ) : (
              <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto flex items-center justify-center transition-colors duration-300"><h1 className="text-2xl text-gray-500">Coming Soon: {activeTab}</h1></main>
            )}
          </Suspense>
          <PlayerBar currentTrack={currentTrack} loadNonce={loadNonce} isPlaying={isPlaying} onTogglePlay={handleTogglePlay} onNextTrack={handleNextTrack} onPrevTrack={handlePrevTrack} isDownloading={isDownloading} playMode={playMode} onTogglePlayMode={handleTogglePlayMode} />
        </div>
      </div>

      <div className={`fixed inset-0 z-[10001] pointer-events-none transition-opacity duration-300 ${isFocused ? 'opacity-0' : 'opacity-100 bg-black/10 dark:bg-black/30'}`} />
      <div id="toast-root" />
    </div>
  );
}
export default App;
