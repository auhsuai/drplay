import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoginGate } from "./ui/LoginGate";
import { FolderSelectionGate } from "./ui/FolderSelectionGate";
import { TrashGate } from "./ui/TrashGate";
import { NowPlayingOverlay } from "./ui/NowPlayingOverlay";
import { captureError } from "./utils/errorLog";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB, TABS } from "./utils/driveConstants";
import { useShallow } from "zustand/react/shallow";
import { TabContentRouter } from "./ui/layouts/TabContentRouter";
import { AppShell } from "./ui/layouts/AppShell";
import { DEBUG_EVENTS, onDebugEvent } from "./ui/debug/debugEvents";

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

import { useServiceWorker } from "./hooks/useServiceWorker";
import { useAppGlobalEvents } from "./hooks/useAppGlobalEvents";
import { useDriveStore } from "./store/driveStore";
import { useLocateFile } from "./hooks/useLocateFile";
import { useNowPlayingShortcuts } from "./ui/NowPlaying/hooks/useNowPlayingShortcuts";

import type { Track, TabKey } from "./types";

import {
  DB_NAV_STATE_KEY,
  LS_CURRENT_FOLDER_ID,
  LS_CURRENT_FOLDER_NAME,
  LS_FOLDER_HISTORY,
  LS_ROOT_FOLDER,
  loadMinimizeToTrayState,
  saveMinimizeToTrayState,
} from "./appUiState";
import { safeLocalStorageRemove } from "./utils/storageKeys";

export { loadMinimizeToTrayState };

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>(TABS.home);
  const { theme, setTheme } = useTheme();
  const [showTrashScreen, setShowTrashScreen] = useState(false);

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
    // Each key goes through the SSOT helper independently: a blocked storage
    // (SecurityError) on one key must not skip the cleanup of the other three
    // (partial cleanup would leak the previous account's folder state).
    safeLocalStorageRemove(LS_ROOT_FOLDER, "logout-cleanup", "App");
    safeLocalStorageRemove(LS_CURRENT_FOLDER_ID, "logout-cleanup", "App");
    safeLocalStorageRemove(LS_CURRENT_FOLDER_NAME, "logout-cleanup", "App");
    safeLocalStorageRemove(LS_FOLDER_HISTORY, "logout-cleanup", "App");
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
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(loadMinimizeToTrayState);

  // F1 fix — TRUE ref-delegate wrappers (pattern: usePlayer.ts
  // stableHandlePlayTrack/handlePlayTrackRef). The PlayerBar memo comparator
  // intentionally ignores handler props (it compares only currentTrack.id /
  // isPlaying / playMode / isDownloading / loadNonce), so a plain useCallback
  // here changes identity WITHOUT ever reaching the memoized child when only
  // the playback queue mutates: the bar keeps firing a closure over the OLD
  // queue (plays deleted tracks / skips newly added ones). The wrapper below
  // keeps a STABLE identity across every render while delegating to the
  // freshest handler through the ref (re-assigned after each commit), so the
  // comparator's shortcut can no longer pin stale queue logic into the bar.
  const handleTogglePlayRef = useRef<typeof handleTogglePlay>(undefined);
  const stableHandleTogglePlay = useCallback(() => {
    void handleTogglePlayRef.current?.();
  }, []);
  const handleNextTrackRef = useRef<typeof handleNextTrack>(undefined);
  const stableHandleNextTrack = useCallback(() => {
    handleNextTrackRef.current?.();
  }, []);
  const handlePrevTrackRef = useRef<typeof handlePrevTrack>(undefined);
  const stableHandlePrevTrack = useCallback(() => {
    handlePrevTrackRef.current?.();
  }, []);
  const handleTogglePlayModeRef =
    useRef<typeof handleTogglePlayMode>(undefined);
  const stableHandleTogglePlayMode = useCallback(() => {
    handleTogglePlayModeRef.current?.();
  }, []);
  // Track selection from the queue panel is navigation, not a queue rebuild —
  // same contract as clicking a song row (isNavigation=true). The handler and
  // activeTab are read through refs so the stable wrapper never closes over a
  // stale queue/tab while PlayerBar's memo comparator ignores handler props.
  const playerPlayTrackRef = useRef<typeof playerPlayTrack>(undefined);
  const activeTabRef = useRef(activeTab);
  const stableHandleSelectTrack = useCallback((track: Track) => {
    void playerPlayTrackRef.current?.(
      track,
      undefined,
      true,
      [],
      activeTabRef.current,
    );
  }, []);
  useEffect(() => {
    handleTogglePlayRef.current = handleTogglePlay;
    handleNextTrackRef.current = handleNextTrack;
    handlePrevTrackRef.current = handlePrevTrack;
    handleTogglePlayModeRef.current = handleTogglePlayMode;
    playerPlayTrackRef.current = playerPlayTrack;
    activeTabRef.current = activeTab;
  }, [
    handleTogglePlay,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlayMode,
    playerPlayTrack,
    activeTab,
  ]);
  const onExpandNowPlaying = useCallback(() => {
    setIsNowPlayingOpen((prev) => !prev);
  }, []);
  const onCloseNowPlaying = useCallback(() => {
    setIsNowPlayingOpen(false);
  }, []);
  // Queue drawer state lives at App level: the pane is docked in AppShell's
  // content row, not inside the memoized PlayerBar. Both wrappers keep a
  // stable identity (empty-dep useCallback + functional update), so the bar
  // is driven purely by the isQueueOpen prop.
  const stableHandleToggleQueue = useCallback(() => {
    setIsQueueOpen((prev) => !prev);
  }, []);
  const stableHandleCloseQueue = useCallback(() => {
    setIsQueueOpen(false);
  }, []);
  useNowPlayingShortcuts({
    isOpen: isNowPlayingOpen,
    onClose: onCloseNowPlaying,
    onToggle: onExpandNowPlaying,
  });

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
    saveMinimizeToTrayState(minimizeToTray);
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
        onSelectTrack={stableHandleSelectTrack}
        onExpandNowPlaying={onExpandNowPlaying}
        isQueueOpen={isQueueOpen}
        onToggleQueue={stableHandleToggleQueue}
        onCloseQueue={stableHandleCloseQueue}
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
            isNowPlayingOpen={isNowPlayingOpen}
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
    </div>
  );
}

export default App;
