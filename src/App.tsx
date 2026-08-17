import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { useTranslation } from "react-i18next";
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
import { DebugPanel } from "./ui/debug/DebugPanel";
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
import { resumeInterruptedUploads } from "./utils/uploadManager";
import { getCurrentUserEmail } from "./utils/storageKeys";

import { useServiceWorker } from "./hooks/useServiceWorker";
import { useAppGlobalEvents } from "./hooks/useAppGlobalEvents";
import { useBackgroundPlayback } from "./hooks/useBackgroundPlayback";
import { useDriveStore } from "./store/driveStore";
import { useTauriEvents } from "./hooks/useTauriEvents";
import { useLocateFile } from "./hooks/useLocateFile";
import {
  handleGlobalBack,
  useHardwareBack,
  createDoubleBackExit,
  DOUBLE_BACK_EXIT_MS,
  registerNativeBackHandler,
} from "./hooks/useHardwareBack";
import { IS_MOBILE } from "./utils/platform";
import { showSuccessToast } from "./utils/simpleToast";

import type { Track, UserProfile, TabKey } from "./types";
export type { Track, UserProfile };

import {
  DB_NAV_STATE_KEY,
  LS_CURRENT_FOLDER_ID,
  LS_CURRENT_FOLDER_NAME,
  LS_FOLDER_HISTORY,
  LS_MINIMIZE_TO_TRAY,
  LS_BACKGROUND_PLAYBACK,
  LS_ROOT_FOLDER,
  loadMinimizeToTrayState,
  loadBackgroundPlaybackState,
} from "./appUiState";

export { loadMinimizeToTrayState };

function App() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>(TABS.home);
  const { theme, setTheme } = useTheme();
  const [showTrashScreen, setShowTrashScreen] = useState(false);
  const [showRateLimitModal, setShowRateLimitModal] = useState(false);

  // Listen to Tauri events (Quota Exceeded, Repair Thumbnail)
  useTauriEvents(setShowRateLimitModal);

  // DEV-only debug trigger (Ctrl+Shift+D panel): same setShowRateLimitModal
  // path as the Tauri event, so the modal opens exactly like a real quota
  // failure. The helper no-ops in production builds.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.RATE_LIMIT, () => {
      setShowRateLimitModal(true);
    });
  }, [setShowRateLimitModal]);

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
  // kept across launches; first launch (no key) defaults to OPEN on desktop
  // and CLOSED on mobile (closed mobile default keeps the hardware-back
  // sidebar handler from swallowing the first back press). 'false' is the
  // only collapsing value; anything else (missing/corrupt) opens — see
  // sidebarState.
  const [isSidebarOpen, setIsSidebarOpen] = useState(loadSidebarOpenState);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(loadMinimizeToTrayState);
  // Mobile-only (Task 3 mobile-polish): "Chạy nhạc nền" — when OFF, playback
  // pauses while the app is hidden. Desktop never reads it (tray path above
  // stays byte-identical); the key is still persisted on both for symmetry.
  const [backgroundPlayback, setBackgroundPlayback] = useState(
    loadBackgroundPlaybackState,
  );
  useBackgroundPlayback(backgroundPlayback);

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
    // update_minimize_to_tray is only registered in the desktop build (cfg
    // gate) — invoking it on Android fails with "Command not found".
    if (!IS_MOBILE) {
      invoke("update_minimize_to_tray", { minimize: minimizeToTray }).catch(
        (e: unknown) =>
          void captureError({
            source: "App",
            message: `minimize-to-tray-failed: ${e instanceof Error ? e.message : String(e)}`,
            kind: "minimize-to-tray-failed",
          }),
      );
    }
  }, [minimizeToTray]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_BACKGROUND_PLAYBACK, String(backgroundPlayback));
    } catch (err) {
      void captureError({
        level: "warn",
        source: "App",
        message: `background-playback-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
      });
    }
  }, [backgroundPlayback]);

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

  // Hardware back button (mobile only): overlay-close handlers run in LIFO
  // order — the LAST registered (highest priority) runs first. Priority:
  // rate-limit modal > trash > folder selection > sidebar > My Drive folder
  // up. All handlers are no-ops on desktop (useHardwareBack skips
  // registration when inactive, and the native back subscriber below
  // early-returns on !IS_MOBILE).
  // Task 14 mobile-polish: My Drive folder drill-down is a navigation layer
  // ABOVE the exit chain — back on a subfolder pops one history level instead
  // of jumping straight to double-back-to-exit. Registered FIRST (checked
  // last) so overlay closes always win; gate is the store's drill-down state
  // (currentFolderId ≠ root on the My Drive tab).
  useHardwareBack(
    () => {
      if (folderHistory.length > 0) {
        handleBack();
      } else {
        // Restore/deep-link edge: a subfolder with empty history (locate-file
        // normally rebuilds it) — jump straight to the configured root.
        setCurrentFolderId(appRootFolder || ROOT_FOLDER_ID);
        setCurrentFolderName(MY_DRIVE_TAB);
      }
      return true;
    },
    activeTab === TABS.myDrive &&
      currentFolderId !== (appRootFolder || ROOT_FOLDER_ID),
  );

  useHardwareBack(() => {
    setIsSidebarOpen(false);
    return true;
  }, isSidebarOpen);

  useHardwareBack(() => {
    setShowFolderSelection(false);
    return true;
  }, showFolderSelection);

  useHardwareBack(() => {
    setShowTrashScreen(false);
    return true;
  }, showTrashScreen);

  useHardwareBack(() => {
    setShowRateLimitModal(false);
    return true;
  }, showRateLimitModal);

  // NowPlaying closes ABOVE every other layer. Declared LAST so its effect
  // flushes after the folder-up handler on every render (effects run in
  // declaration order inside a component) and LIFO always checks it first —
  // back with NowPlaying open in a drill-down subfolder closes the overlay
  // instead of popping folder history. Deliberately NOT memoized: the sibling
  // handlers are inline too, and re-registering last on each render is what
  // keeps this handler on top of the stack.
  useHardwareBack(() => {
    setIsNowPlayingOpen(false);
    return true;
  }, isNowPlayingOpen);

  // Android hardware back button via Tauri's official onBackButtonPress event
  // (2.9+) — each native press fires the chain directly, so no synthetic
  // history entries are pushed anymore. Back order: registered overlay stack
  // (incl. NowPlaying, registered last → top of LIFO) → any non-Home tab →
  // Home → double-back-to-exit (Android convention: hint toast + 2s window
  // before the root press exits). Runs ONLY on mobile — desktop keeps native
  // window history and never subscribes.
  const navStateRef = useRef({
    activeTab,
    handleTabChange,
    t,
  });
  useEffect(() => {
    navStateRef.current = { activeTab, handleTabChange, t };
  }, [activeTab, handleTabChange, t]);

  useEffect(() => {
    if (!IS_MOBILE) return;

    // Task 9 mobile-polish: Android "Press back again to exit" convention —
    // at the root the FIRST back press shows a hint toast and arms a 2s
    // window; a second press inside the window exits. windowMs matches the
    // platform convention (2000ms). onArm/onExit read live state via the ref
    // so this mount-once effect never goes stale.
    const doubleBack = createDoubleBackExit({
      windowMs: DOUBLE_BACK_EXIT_MS,
      onArm: () => {
        showSuccessToast(
          navStateRef.current.t("back.press_again_to_exit", {
            defaultValue: "Nhấn back lần nữa để thoát",
          }),
        );
      },
      onExit: () => {
        // plugin-process exit(0) is the documented Tauri v2 way to exit on
        // Android; the WebView's own window.close() would be a no-op there
        // (Chromium only lets scripts close windows they opened), so it stays
        // as the last-resort fallback.
        exit(0).catch(() => {
          getCurrentWindow()
            .close()
            .catch(() => {
              window.close();
            });
        });
      },
    });

    // Task 9 mobile-polish upgrade: back now arrives via the native
    // onBackButtonPress event instead of a popstate listener. The chain is
    // identical to the old pushState hack — handleGlobalBack first (registered
    // overlay stack, NowPlaying included), then tab → Home, then
    // double-back-exit.
    const unregisterBack = registerNativeBackHandler(() => {
      if (handleGlobalBack()) return;

      const state = navStateRef.current;
      let handled = false;

      if (state.activeTab !== TABS.home) {
        state.handleTabChange(TABS.home);
        handled = true;
      }

      if (!handled) {
        // Root (Home): the press arms the 2s double-back window (onArm fires
        // the hint toast); a second press inside the window takes the exit
        // path via onExit.
        doubleBack.handleBack();
      }
    });

    return () => {
      unregisterBack();
      doubleBack.disarm();
    };
  }, []);

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
            backgroundPlayback={backgroundPlayback}
            setBackgroundPlayback={setBackgroundPlayback}
            setShowFolderSelection={setShowFolderSelection}
            setShowTrashScreen={setShowTrashScreen}
            onLogout={() => {
              // Fire-and-forget: useAuth's handleLogout handles its own errors.
              void handleLogout();
            }}
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
          handleTabChange(TABS.home);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />

      {/* DEV-only debug UI panel (Ctrl+Shift+D); never shipped in production */}
      {import.meta.env.DEV && <DebugPanel />}
    </div>
  );
}

export default App;
