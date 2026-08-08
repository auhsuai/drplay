import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoginGate } from "./ui/LoginGate";
import { FolderSelectionGate } from "./ui/FolderSelectionGate";
import { TrashGate } from "./ui/TrashGate";
import { NowPlayingOverlay } from "./ui/NowPlayingOverlay";
import { RateLimitGate } from "./ui/RateLimitGate";
import { captureError } from "./utils/errorLog";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB, TABS } from "./utils/driveConstants";
import { useShallow } from "zustand/react/shallow";
import { TabContentRouter } from "./ui/layouts/TabContentRouter";
import { AppShell } from "./ui/layouts/AppShell";

import "./App.css";

import { db } from "./db/db";
import { clearSessionState } from "./utils/sessionCleanup";
import {
  loadSidebarOpenState,
  saveSidebarOpenState,
} from "./utils/sidebarState";

import { useAuth } from "./hooks/useAuth";
import { usePlayer } from "./hooks/usePlayer";
import { useDrive } from "./hooks/useDrive";
import { useTheme } from "./hooks/useTheme";
import { resumeInterruptedUploads } from "./utils/uploadManager";
import { getCurrentUserEmail } from "./utils/storageKeys";

import { useServiceWorker } from "./hooks/useServiceWorker";
import { useAppGlobalEvents } from "./hooks/useAppGlobalEvents";
import { useDriveStore } from "./store/driveStore";
import { useTauriEvents } from "./hooks/useTauriEvents";
import { useLocateFile } from "./hooks/useLocateFile";

import type { Track, UserProfile, TabKey } from "./types";
export type { Track, UserProfile };

import {
  DB_NAV_STATE_KEY,
  LS_CURRENT_FOLDER_ID,
  LS_CURRENT_FOLDER_NAME,
  LS_FOLDER_HISTORY,
  LS_MINIMIZE_TO_TRAY,
  LS_ROOT_FOLDER,
  loadMinimizeToTrayState,
} from "./appUiState";

export { loadMinimizeToTrayState };

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>(TABS.home);
  const { theme, setTheme } = useTheme();
  const [showTrashScreen, setShowTrashScreen] = useState(false);
  const [showRateLimitModal, setShowRateLimitModal] = useState(false);

  // Listen to Tauri events (Quota Exceeded, Repair Thumbnail)
  useTauriEvents(setShowRateLimitModal);

  // setAppRootFolder is produced by useDrive() BELOW, while the logout cleanup
  // callback above runs at logout time. A ref bridges the TDZ (the callback
  // must not touch a `const` declared later in the component body).
  const setAppRootFolderRef = useRef<(folderId: string | null) => void>(
    () => {},
  );

  const {
    isLoggedIn,
    accessToken,
    userProfile,
    handleLoginSuccess,
    handleLogout,
  } = useAuth(() => {
    try {
      localStorage.removeItem(LS_ROOT_FOLDER);
      localStorage.removeItem(LS_CURRENT_FOLDER_ID);
      localStorage.removeItem(LS_CURRENT_FOLDER_NAME);
      localStorage.removeItem(LS_FOLDER_HISTORY);
    } catch (err) {
      void captureError({
        level: "warn",
        source: "App",
        message: `logout-cleanup-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
        kind: "localstorage-cleanup-failed",
      });
    }
    db.syncState.delete(DB_NAV_STATE_KEY).catch(
      (e: unknown) =>
        void captureError({
          source: "App",
          message: `logout-cleanup-failed: ${e instanceof Error ? e.message : String(e)}`,
          kind: "logout-cleanup-failed",
        }),
    );
    clearSessionState();
    setAppRootFolderRef.current(null);
  });

  // Initialize service worker; pass the access token so the SW learns it on
  // login/refresh/logout (it keeps its own in-memory copy, see useServiceWorker).
  useServiceWorker(accessToken);

  // Global window events (Focus, blur, contextmenu, auth-logout). handleLogout
  // is async; errors are handled internally by useAuth (each step is wrapped),
  // so this stays fire-and-forget via the stable wrapper below.
  const onGlobalLogout = useCallback(() => {
    void handleLogout();
  }, [handleLogout]);
  useAppGlobalEvents(onGlobalLogout);

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
    loadNonce,
  } = usePlayer(accessToken);

  const [showFolderSelection, setShowFolderSelection] = useState(false);
  // Lazy initializer (read once on mount, no default-flash): stored state is
  // kept across launches; first launch (no key) defaults to OPEN, the opposite
  // of the old hardcoded collapsed default. 'false' is the only collapsing
  // value; anything else (missing/corrupt) opens — see sidebarState.
  const [isSidebarOpen, setIsSidebarOpen] = useState(loadSidebarOpenState);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(loadMinimizeToTrayState);

  const stableHandleTogglePlay = useCallback(() => {
    void handleTogglePlay();
  }, [handleTogglePlay]);
  const stableHandleNextTrack = useCallback(() => {
    handleNextTrack();
  }, [handleNextTrack]);
  const stableHandlePrevTrack = useCallback(() => {
    handlePrevTrack();
  }, [handlePrevTrack]);
  const stableHandleTogglePlayMode = useCallback(() => {
    handleTogglePlayMode();
  }, [handleTogglePlayMode]);
  const onExpandNowPlaying = useCallback(() => {
    setIsNowPlayingOpen((prev) => !prev);
  }, []);

  const handlePlayTrack = (
    track: Track,
    contextQueue?: Track[],
    isNavigation: boolean = false,
  ) => {
    // Fire-and-forget: usePlayer's handlePlayTrack handles its own errors.
    void playerPlayTrack(track, contextQueue, isNavigation, [], activeTab);
  };

  useEffect(() => {
    setAppRootFolderRef.current = setAppRootFolder;
  }, [setAppRootFolder]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_MINIMIZE_TO_TRAY, String(minimizeToTray));
    } catch (err) {
      void captureError({
        level: "warn",
        source: "App",
        message: `tray-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
      });
    }
    invoke("update_minimize_to_tray", { minimize: minimizeToTray }).catch(
      (e: unknown) =>
        void captureError({
          source: "App",
          message: `minimize-to-tray-failed: ${e instanceof Error ? e.message : String(e)}`,
          kind: "minimize-to-tray-failed",
        }),
    );
  }, [minimizeToTray]);

  const handleTabChange = useCallback(
    (tab: TabKey) => {
      if (activeTab === tab && tab === TABS.myDrive) {
        setCurrentFolderId(appRootFolder || ROOT_FOLDER_ID);
        setCurrentFolderName(MY_DRIVE_TAB);
        setFolderHistory([]);
      }
      setActiveTab(tab);
    },
    [
      activeTab,
      appRootFolder,
      setCurrentFolderId,
      setCurrentFolderName,
      setFolderHistory,
    ],
  );

  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-white dark:bg-[#121212] transition-colors duration-300">
      {/* Login Overlay */}
      <LoginGate
        isLoggedIn={isLoggedIn}
        onLogin={(tokens) => {
          handleLoginSuccess({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in,
          });
          // Fire-and-forget: resumeInterruptedUploads guards itself against
          // double-runs and never rejects (every step is caught inside — a
          // failure only surfaces as a warn log and/or the aggregated
          // interrupted toast). getCurrentUserEmail is the SAME source the
          // manager persists session rows under, so the scan always queries
          // the exact key the interrupted rows were written with.
          void resumeInterruptedUploads(
            tokens.access_token,
            getCurrentUserEmail(),
          );
        }}
      />

      {/* Folder Selection Overlay */}
      <FolderSelectionGate
        isLoggedIn={isLoggedIn}
        appRootFolder={appRootFolder}
        showFolderSelection={showFolderSelection}
        token={accessToken}
        onSelectFolder={(folderId) => {
          // Fire-and-forget: useDrive's handleSelectRootFolder handles its
          // own errors (each step is try/caught inside).
          void handleSelectRootFolder(folderId);
          setShowFolderSelection(false);
        }}
        onCancel={
          appRootFolder
            ? () => {
                setShowFolderSelection(false);
              }
            : undefined
        }
      />

      <TrashGate
        showTrashScreen={showTrashScreen}
        token={accessToken}
        onClose={() => {
          setShowTrashScreen(false);
        }}
      />

      <AppShell
        isLoggedIn={isLoggedIn}
        appRootFolder={appRootFolder}
        showFolderSelection={showFolderSelection}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        userProfile={userProfile}
        onLogout={() => {
          // Fire-and-forget: useAuth's handleLogout handles its own errors.
          void handleLogout();
        }}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => {
          const nextOpen = !isSidebarOpen;
          setIsSidebarOpen(nextOpen);
          saveSidebarOpenState(nextOpen);
        }}
        token={accessToken}
        isNowPlayingOpen={isNowPlayingOpen}
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
        tabContent={
          <TabContentRouter
            activeTab={activeTab}
            isLoggedIn={isLoggedIn}
            userProfile={userProfile}
            token={accessToken}
            currentTrack={currentTrack}
            onPlayTrack={handlePlayTrack}
            onOpenFolder={handleOpenFolder}
            onSwitchTab={handleTabChange}
            isLoading={isLoadingTracks}
            onBack={handleBack}
            hasHistory={folderHistory.length > 0}
            folderHistory={folderHistory}
            currentFolderName={currentFolderName}
            currentFolderId={currentFolderId}
            onBreadcrumbClick={handleBreadcrumbClick}
            highlightedFileId={highlightedFileId}
            sortOption={sortOption}
            setSortOption={setSortOption}
            theme={theme}
            setTheme={setTheme}
            minimizeToTray={minimizeToTray}
            setMinimizeToTray={setMinimizeToTray}
            setShowFolderSelection={setShowFolderSelection}
            setShowTrashScreen={setShowTrashScreen}
          />
        }
      />

      {/* Now Playing Full Screen Overlay */}
      <NowPlayingOverlay
        isOpen={isNowPlayingOpen}
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        onTogglePlay={stableHandleTogglePlay}
        onNextTrack={stableHandleNextTrack}
        onPrevTrack={stableHandlePrevTrack}
        playMode={playMode}
        onTogglePlayMode={stableHandleTogglePlayMode}
        onBack={() => {
          setIsNowPlayingOpen(false);
        }}
        token={accessToken}
      />

      <RateLimitGate
        isOpen={showRateLimitModal}
        onClose={() => {
          setShowRateLimitModal(false);
        }}
        onOk={() => {
          setShowRateLimitModal(false);
          handleTabChange("Home");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />

      {/* Toast container: simpleToast appends here; must stay mounted for the
          app's whole lifetime so showErrorToast/showSuccessToast work everywhere */}
      <div id="toast-root" />
    </div>
  );
}

export default App;
