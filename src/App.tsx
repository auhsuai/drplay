import React, { useState, useCallback, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./ui/Sidebar/Sidebar";
import { NowPlayingView } from "./ui/NowPlaying/NowPlayingView";
import { PlayerBar } from "./ui/PlayerBar/PlayerBar";
import { FolderSelectionScreen } from "./ui/FolderSelection/FolderSelectionScreen";
import { TrashScreen } from "./ui/Settings/TrashScreen";
import { RateLimitModal } from "./ui/components/RateLimitModal";
import { captureError } from "./utils/errorLog";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB, TABS } from "./utils/driveConstants";
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
import { loadSidebarOpenState, saveSidebarOpenState } from "./utils/sidebarState";

import { useAuth } from "./hooks/useAuth";
import { usePlayer } from "./hooks/usePlayer";
import { useDrive } from "./hooks/useDrive";
import { useTheme } from "./hooks/useTheme";

import { useServiceWorker } from "./hooks/useServiceWorker";
import { useAppGlobalEvents } from './hooks/useAppGlobalEvents';
import { useDriveStore } from './store/driveStore';
import { useTauriEvents } from "./hooks/useTauriEvents";
import { useLocateFile } from "./hooks/useLocateFile";

import type { Track, UserProfile, TabKey } from './types';
export type { Track, UserProfile };


const LS_ROOT_FOLDER = 'drplay_root_folder';
const LS_CURRENT_FOLDER_ID = 'drplay_current_folder_id';
const LS_CURRENT_FOLDER_NAME = 'drplay_current_folder_name';
const LS_FOLDER_HISTORY = 'drplay_folder_history';
const LS_SORT_OPTION = 'drplay_sort_option';
const LS_MINIMIZE_TO_TRAY = 'drplay_minimize_to_tray';
const DB_NAV_STATE_KEY = 'drplay_nav_state';

// Lazy-useState-compatible reader for the tray-minimize preference: missing
// key (first launch) defaults to minimized; only the literal 'true' means
// minimized, any other stored value ('false'/corrupt) means not-minimized.
// localStorage access can throw SecurityError (storage blocked by policy —
// see MDN Window.localStorage), so the read is guarded and falls back to the
// default like a missing key.
export function loadMinimizeToTrayState(): boolean {
  try {
    const saved = localStorage.getItem(LS_MINIMIZE_TO_TRAY);
    return saved !== null ? saved === "true" : true;
  } catch {
    return true; // storage blocked — default behavior (same as missing key)
  }
}

function App() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>(TABS.home);
  const { theme, setTheme } = useTheme();
  const [showTrashScreen, setShowTrashScreen] = useState(false);
  const [showRateLimitModal, setShowRateLimitModal] = useState(false);

  // Listen to Tauri events (Quota Exceeded, Repair Thumbnail)
  useTauriEvents(setShowRateLimitModal);

  const { isLoggedIn, accessToken, userProfile, handleLoginSuccess, handleLogout } = useAuth(() => {
    try {
      localStorage.removeItem(LS_ROOT_FOLDER);
      localStorage.removeItem(LS_CURRENT_FOLDER_ID);
      localStorage.removeItem(LS_CURRENT_FOLDER_NAME);
      localStorage.removeItem(LS_FOLDER_HISTORY);
    } catch (err) {
      captureError({
        level: 'warn',
        source: 'App',
        message: `logout-cleanup-failed:${err instanceof Error || err instanceof DOMException ? err.name : 'unknown'}`,
        kind: 'localstorage-cleanup-failed'
      });
    }
    db.syncState.delete(DB_NAV_STATE_KEY).catch((e) => captureError({ source: 'App', message: `logout-cleanup-failed: ${e instanceof Error ? e.message : String(e)}`, kind: 'logout-cleanup-failed' }));
    clearSessionState();
    setAppRootFolder(null);
  });

  // Initialize service worker; pass the access token so the SW learns it on
  // login/refresh/logout (it keeps its own in-memory copy, see useServiceWorker).
  useServiceWorker(accessToken);

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
  // Lazy initializer (read once on mount, no default-flash): stored state is
  // kept across launches; first launch (no key) defaults to OPEN, the opposite
  // of the old hardcoded collapsed default. 'false' is the only collapsing
  // value; anything else (missing/corrupt) opens — see sidebarState.
  const [isSidebarOpen, setIsSidebarOpen] = useState(loadSidebarOpenState);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(loadMinimizeToTrayState);

  useEffect(() => {
    try {
      localStorage.setItem(LS_MINIMIZE_TO_TRAY, String(minimizeToTray));
    } catch (err) {
      captureError({
        level: 'warn',
        source: 'App',
        message: `tray-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : 'unknown'}`
      });
    }
    invoke("update_minimize_to_tray", { minimize: minimizeToTray }).catch((e) => captureError({ source: 'App', message: `minimize-to-tray-failed: ${e instanceof Error ? e.message : String(e)}`, kind: 'minimize-to-tray-failed' }));
  }, [minimizeToTray]);

  const handleTabChange = useCallback((tab: TabKey) => {
    if (activeTab === tab && tab === TABS.myDrive) {
      setCurrentFolderId(appRootFolder || ROOT_FOLDER_ID);
      setCurrentFolderName(MY_DRIVE_TAB);
      setFolderHistory([]);
    }
    setActiveTab(tab);
  }, [activeTab, appRootFolder, setCurrentFolderId, setCurrentFolderName, setFolderHistory]);

  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-white dark:bg-[#121212] transition-colors duration-300">
      {/* Login Overlay */}
      {!isLoggedIn && <LoginScreen onLogin={(tokens) => handleLoginSuccess({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in })} />}

      {/* Folder Selection Overlay */}
      {(isLoggedIn && (!appRootFolder || showFolderSelection)) && (
        <FolderSelectionScreen
          token={accessToken ?? ''}
          onSelectFolder={(folderId) => {
            handleSelectRootFolder(folderId);
            setShowFolderSelection(false);
          }}
          onCancel={appRootFolder ? () => setShowFolderSelection(false) : undefined}
          initialFolderId={ROOT_FOLDER_ID}
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
          onToggleSidebar={() => {
            const nextOpen = !isSidebarOpen;
            setIsSidebarOpen(nextOpen);
            saveSidebarOpenState(nextOpen);
          }}
          token={accessToken}
        />

        <div id="content-area" className="flex-1 relative overflow-hidden flex flex-col">
          {/* Lazy tab chunks load on first visit — a compact blue spinner
              (the familiar pre-skeleton loading) instead of a heavy skeleton
              list: settings and other non-list tabs have no file rows to
              mirror, so a skeleton would just sit there unrelated. */}
          <Suspense fallback={<div role="status" aria-label={t('loading')} className="flex-1 flex items-center justify-center"><Loader2 className="animate-spin h-10 w-10 text-[#4285F4] stroke-[1.5]" /></div>}>
            {/* HomeTab stays mounted across tab switches (keep-alive): hiding
                it with display:none instead of unmounting prevents the
                refetch-on-remount churn of every home data load
                (getRecentlyPlayed / getHeavyRotation / getRandomDiscoveries /
                getMostVisitedFolders / getRecentlyAddedAudioFiles) and keeps
                scroll/greeting state. The key forces a clean remount per login
                session: logout -> login must not reuse the previous account's
                HomeTab state. accessToken is deliberately NOT the key — it
                rotates on every refresh and would remount constantly. */}
            <div className={activeTab === TABS.home ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
              <HomeTab 
                key={isLoggedIn ? 'session-in' : 'session-out'}
                onPlay={(t: Track, c?: Track[]) => handlePlayTrack(t, c)} 
                onOpenFolder={(id, name) => {
                  handleOpenFolder(id, name);
                  handleTabChange(TABS.myDrive);
                }}
                token={accessToken} 
                userProfile={userProfile} 
                currentTrack={currentTrack}
              />
            </div>
            {activeTab !== TABS.home && (activeTab === TABS.myDrive ? (
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
                currentTrack={currentTrack}
                highlightedFileId={highlightedFileId}
                onRefresh={() => { /* No-op, sync runs in background */ }}
                onRemoveItem={() => { /* useLiveQuery handles UI updates automatically now */ }}
                sortOption={sortOption}
                onSortChange={(val) => {
                  setSortOption(val);
                  try {
                    localStorage.setItem(LS_SORT_OPTION, val);
                  } catch (err) {
                    captureError({
                      level: 'warn',
                      source: 'App',
                      message: `sort-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : 'unknown'}`
                    });
                  }
                }}
              />
            ) : activeTab === TABS.likedSongs ? (
              <LikedSongs onPlay={(t: Track, c: Track[]) => { handlePlayTrack(t, c); }} token={accessToken} currentTrack={currentTrack} />
            ) : activeTab.startsWith("playlist_") ? (
              <PlaylistView
                playlistId={activeTab.replace("playlist_", "")}
                onPlay={(t: Track, c?: Track[]) => { handlePlayTrack(t, c); }}
                onDelete={() => handleTabChange(TABS.home)}
                currentTrack={currentTrack}
              />
            ) : activeTab === TABS.settings ? (
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
                <h1 className="text-2xl text-gray-500">{t('common.coming_soon', 'Coming Soon')}: {activeTab}</h1>
              </main>
            ))}
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
