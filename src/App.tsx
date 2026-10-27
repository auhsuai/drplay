import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18next from "i18next";
import { setVideoHostOwner, type VideoHostOwner } from "./lib/videoHost";
import {
  closePipWindow,
  isPipWindowOpen,
  openPipWindowAndWaitReady,
  requestPipOwner,
  PIP_EVENTS,
  PIP_WINDOW_LABEL,
  type PipActionEvent,
  type PipStatePayload,
} from "./lib/pipWindow";
import { LoginGate } from "./ui/LoginGate";
import { FolderSelectionGate } from "./ui/FolderSelectionGate";
import { TrashGate } from "./ui/TrashGate";
import { NowPlayingOverlay } from "./ui/NowPlayingOverlay";
import { captureError } from "./utils/errorLog";
import {
  ROOT_FOLDER_ID,
  MY_DRIVE_TAB,
  TABS,
  VIRTUAL_ROOT_ID,
  VIRTUAL_ROOT_NAME,
} from "./utils/driveConstants";
import { useShallow } from "zustand/react/shallow";
import { TabContentRouter } from "./ui/layouts/TabContentRouter";
import { AppShell, isShellLocked } from "./ui/layouts/AppShell";
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
import { usePlayerStore } from "./store/playerStore";
import { useLocateFile } from "./hooks/useLocateFile";
import { useNowPlayingShortcuts } from "./ui/NowPlaying/hooks/useNowPlayingShortcuts";
import { usePlayerCommands } from "./player/usePlayerCommands";
import { useFullscreenChrome } from "./player/useFullscreenChrome";
import { useAutoHideCursor } from "./player/useAutoHideCursor";
import {
  applyWindowFullscreen,
  syncWindowFullscreenState,
} from "./player/windowFullscreen";
import { useVideoContextMenu } from "./player/useVideoContextMenu";
import { useVideoMenu } from "./player/useVideoMenu";
import { VideoMenu } from "./ui/components/MoreMenu/VideoMenu";
import { onPlayerUi } from "./player/playerUiBus";
import type { PlayerCommandContext } from "./player/commands";
import { MediaInfoDialog } from "./ui/NowPlaying/components/MediaInfoDialog";
import { AudioController } from "./lib/AudioController";
import { isForeignTrackEvent } from "./lib/audioNativeEvents";
import { ensureVideoHostAcquired } from "./lib/videoHost";
import { VIDEO_HOST_OWNER_CHANGED_EVENT } from "./ui/NowPlaying/components/VideoSurface";
import { classifyMediaKind, MEDIA_KIND_VIDEO } from "./utils/mediaKind";
import { showErrorToast, showSuccessToast } from "./utils/simpleToast";

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
import {
  ROOT_FOLDERS_KEY,
  ROOT_FOLDERS_UPDATED_KEY,
  safeLocalStorageRemove,
} from "./utils/storageKeys";

export { loadMinimizeToTrayState };

const PIP_STATE_POLL_MS = 400;
/** Liveness check for the PiP window while it is supposed to be active. */
const PIP_WINDOW_POLL_MS = 1_000;

function safePlaybackTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safePlaybackVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function logPipError(
  kind: string,
  error: unknown,
  level: "warn" | "error" = "error",
): void {
  void captureError({
    level,
    source: "App",
    message: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
    kind,
  });
}

function setPipHostOwner(owner: VideoHostOwner): void {
  setVideoHostOwner(owner);
  window.dispatchEvent(new Event(VIDEO_HOST_OWNER_CHANGED_EVENT));
}

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
    isAuthHydrated,
    accessToken,
    userProfile,
    handleLoginSuccess,
    handleLogout,
  } = useAuth(() => {
    // Each key goes through the SSOT helper independently: a blocked storage
    // (SecurityError) on one key must not skip the cleanup of the other three
    // (partial cleanup would leak the previous account's folder state).
    safeLocalStorageRemove(LS_ROOT_FOLDER, "logout-cleanup", "App");
    safeLocalStorageRemove(ROOT_FOLDERS_KEY, "logout-cleanup", "App");
    safeLocalStorageRemove(ROOT_FOLDERS_UPDATED_KEY, "logout-cleanup", "App");
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
    useDriveStore.getState().setRootFolders([]);
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
    rootFolders,
    isHydrated,
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
    commitRootFolders,
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
    handleSetPlayMode,
    loadNonce,
  } = usePlayer(accessToken);

  const isVideoActive =
    currentTrack !== null &&
    classifyMediaKind(currentTrack.originalName ?? currentTrack.title) ===
      MEDIA_KIND_VIDEO;

  const errorInfo = usePlayerStore((state) => state.errorInfo);
  const [isBuffering, setIsBuffering] = useState(false);
  const [hasEnded, setHasEnded] = useState(false);
  const [pipStateTrackId, setPipStateTrackId] = useState(currentTrack?.id);
  const [pipStateLoadNonce, setPipStateLoadNonce] = useState(loadNonce);
  if (
    pipStateTrackId !== currentTrack?.id ||
    pipStateLoadNonce !== loadNonce
  ) {
    setPipStateTrackId(currentTrack?.id);
    setPipStateLoadNonce(loadNonce);
    setIsBuffering(false);
    setHasEnded(false);
  }
  const pipTransitionRef = useRef(false);
  // Mirror of isPipActive that event listeners and async recovery reads can
  // trust synchronously (state updates are not visible until the next render).
  const isPipActiveRef = useRef(false);

  const [showFolderSelection, setShowFolderSelection] = useState(false);
  // Lazy initializer (read once on mount, no default-flash): stored state is
  // kept across launches; first launch (no key) defaults to OPEN, the opposite
  // of the old hardcoded collapsed default. 'false' is the only collapsing
  // value; anything else (missing/corrupt) opens — see sidebarState.
  const [isSidebarOpen, setIsSidebarOpen] = useState(loadSidebarOpenState);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);
  // Player fullscreen (TASK 1). A REFINEMENT of the overlay, not a second
  // surface: it is owned here so the Escape handler can peel exactly one
  // layer (fullscreen -> overlay -> nothing), and it never reaches Rust or
  // mpv — the native host stays inside the app window either way.
  // Player fullscreen (TASK 1). A REFINEMENT of the overlay, not a second
  // surface: it is owned here so the Escape handler can peel exactly one
  // layer (fullscreen -> overlay -> nothing), and it never reaches Rust or
  // mpv — the native host stays inside the app window either way.
  //
  // Slice 1: this flag now also drives the REAL window fullscreen
  // (applyWindowFullscreen below), so "fullscreen" means the OS window is
  // fullscreen, not just a bigger video area in the same window.
  const [isPlayerFullscreen, setIsPlayerFullscreen] = useState(false);
  const [isPipActive, setIsPipActive] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(loadMinimizeToTrayState);
  // Media Information dialog (D2b): owned here because the player-ui bus
  // (PLAYER_MEDIA_INFO command) and the menu both open it.
  const [isMediaInfoOpen, setIsMediaInfoOpen] = useState(false);
  const handleCloseMediaInfo = useCallback(() => {
    setIsMediaInfoOpen(false);
  }, []);

  useEffect(() => {
    const audio = AudioController.getInstance();
    const isForeign = (identity: { trackId?: string } | undefined): boolean =>
      isForeignTrackEvent(identity, usePlayerStore.getState().currentTrack?.id);
    const unsubBuffering = audio.on(
      "buffering",
      ({ isBuffering: buffering, ...identity }) => {
        if (isForeign(identity)) return;
        setIsBuffering(buffering);
      },
    );
    const unsubEnded = audio.on("ended", (identity) => {
      if (isForeign(identity)) return;
      setHasEnded(true);
    });
    // A new engine `play` (auto-advance, replay, resume) starts a fresh
    // timeline: an untagged `ended` from the previous item must not keep the
    // video surface hidden for the next one.
    const unsubPlay = audio.on("play", (identity) => {
      if (isForeign(identity)) return;
      setHasEnded(false);
    });
    return () => {
      unsubBuffering();
      unsubEnded();
      unsubPlay();
    };
  }, []);

  useEffect(() => {
    isPipActiveRef.current = isPipActive;
  }, [isPipActive]);

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
    // `f` collapses as well as expands, so it also leaves fullscreen — the
    // overlay closing must never leave the fullscreen flag latched.
    setIsNowPlayingOpen((prev) => {
      if (prev) setIsPlayerFullscreen(false);
      return !prev;
    });
  }, []);
  // Leaving the overlay always leaves fullscreen too: fullscreen is only
  // meaningful while the overlay is up, and keeping the flag would re-enter it
  // on the next open.
  const stableHandleCloseNowPlaying = useCallback(() => {
    setIsNowPlayingOpen(false);
    setIsPlayerFullscreen(false);
  }, []);
  // Entering fullscreen opens the overlay in the same commit, so there is no
  // frame where `isPlayerFullscreen` is true while the surface is hidden.
  const stableHandleToggleFullscreen = useCallback(() => {
    setIsNowPlayingOpen(true);
    setIsPlayerFullscreen((prev) => !prev);
  }, []);
  const stableHandleExitFullscreen = useCallback(() => {
    setIsPlayerFullscreen(false);
  }, []);

  const publishPipState = useCallback(() => {
    const audio = AudioController.getInstance();
    const payload: PipStatePayload = {
      title: currentTrack?.title ?? "",
      isPlaying,
      currentTime: safePlaybackTime(audio.getCurrentTime()),
      duration: safePlaybackTime(audio.getDuration()),
      volume: safePlaybackVolume(audio.getVolume()),
      isMuted: audio.isMuted(),
      hasTrack: currentTrack !== null,
      isVideo: isVideoActive,
      isBuffering,
      hasError: errorInfo !== null,
      hasEnded,
    };
    try {
      void emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.state, payload).catch(
        (error: unknown) => {
          logPipError("pip-state-publish-failed", error, "warn");
        },
      );
    } catch (error) {
      logPipError("pip-state-publish-failed", error, "warn");
    }
  }, [
    currentTrack,
    isPlaying,
    isVideoActive,
    isBuffering,
    errorInfo,
    hasEnded,
  ]);

  const publishPipStateRef = useRef<() => void>(() => {});
  useEffect(() => {
    publishPipStateRef.current = publishPipState;
  }, [publishPipState]);

  // The main window can be minimized/hidden (tray) while PiP owns the video.
  // Returning must restore it BEFORE the PiP surface is destroyed, or the
  // retarget lands in a window nobody can see. Each step is independent:
  // show() on a minimized window is a no-op, so unminimize() is required too.
  const restoreMainWindowForPip = useCallback(async () => {
    try {
      const mainWindow = getCurrentWindow();
      try {
        await mainWindow.show();
      } catch (error) {
        logPipError("return-main-show-failed", error, "warn");
      }
      try {
        await mainWindow.unminimize();
      } catch (error) {
        logPipError("return-main-unminimize-failed", error, "warn");
      }
      try {
        await mainWindow.setFocus();
      } catch (error) {
        logPipError("return-main-focus-failed", error, "warn");
      }
    } catch (error) {
      logPipError("return-main-window-failed", error, "warn");
    }
  }, []);

  const enterPip = useCallback(async () => {
    if (pipTransitionRef.current || isPipActiveRef.current) return;
    if (!isVideoActive) {
      showErrorToast(i18next.t("player.pip.no_video"));
      return;
    }

    pipTransitionRef.current = true;
    let retargetedToPip = false;
    try {
      await openPipWindowAndWaitReady();
      publishPipStateRef.current();
      await invoke("video_surface_retarget_to_pip_cmd");
      retargetedToPip = true;
      setPipHostOwner("pip");

      let ownerSynced = await requestPipOwner("pip");
      if (!ownerSynced) {
        ownerSynced = await requestPipOwner("pip");
      }
      if (!ownerSynced) {
        throw new Error("pip window did not acknowledge ownership");
      }

      isPipActiveRef.current = true;
      setIsPipActive(true);
      setIsNowPlayingOpen(false);
      setIsPlayerFullscreen(false);
      publishPipStateRef.current();
    } catch (error) {
      logPipError("enter-failed", error);
      if (retargetedToPip) {
        try {
          await invoke("video_surface_retarget_to_main_cmd");
        } catch (rollbackError) {
          logPipError("enter-rollback-retarget-failed", rollbackError);
          // The native target may still be the PiP window. Declaring main
          // here would strand the picture, so keep PiP as the presentation
          // owner (and the window alive) until a successful Return retries.
          isPipActiveRef.current = true;
          setIsPipActive(true);
          setIsNowPlayingOpen(false);
          setIsPlayerFullscreen(false);
          setPipHostOwner("pip");
          const resynced = await requestPipOwner("pip");
          if (!resynced) {
            logPipError(
              "enter-rollback-owner-resync-failed",
              new Error("pip window did not acknowledge ownership"),
              "warn",
            );
          }
          showErrorToast(i18next.t("player.pip.enter_error"));
          return;
        }
      }
      setPipHostOwner("main");
      isPipActiveRef.current = false;
      setIsPipActive(false);
      setIsNowPlayingOpen(true);
      showErrorToast(i18next.t("player.pip.enter_error"));
      try {
        await closePipWindow();
      } catch (closeError) {
        logPipError("enter-rollback-close-failed", closeError);
      }
    } finally {
      pipTransitionRef.current = false;
    }
  }, [isVideoActive]);

  const returnFromPip = useCallback(async () => {
    if (!isPipActiveRef.current || pipTransitionRef.current) return;
    pipTransitionRef.current = true;

    try {
      try {
        await invoke("video_surface_retarget_to_main_cmd");
      } catch (error) {
        logPipError("return-retarget-failed", error);
        try {
          await emitTo(PIP_WINDOW_LABEL, PIP_EVENTS.refreshSurface);
        } catch (refreshError) {
          logPipError("return-refresh-failed", refreshError, "warn");
        }
        showErrorToast(i18next.t("player.pip.return_error"));
        return;
      }

      // Retarget succeeded; the main window owns the surface now. Restore its
      // visibility BEFORE tearing the PiP window down.
      await restoreMainWindowForPip();

      setPipHostOwner("main");
      isPipActiveRef.current = false;
      setIsPipActive(false);
      setIsNowPlayingOpen(true);

      try {
        await closePipWindow();
      } catch (error) {
        logPipError("return-close-failed", error);
      }
    } finally {
      pipTransitionRef.current = false;
    }
  }, [restoreMainWindowForPip]);

  const recoverFromExternalPipClose = useCallback(async () => {
    if (!isPipActiveRef.current || pipTransitionRef.current) return;
    pipTransitionRef.current = true;
    // Stop accepting PiP actions immediately: that window is gone.
    isPipActiveRef.current = false;
    try {
      logPipError(
        "pip-window-lost",
        "pip window disappeared while active; recovering to main",
        "warn",
      );
      try {
        await invoke("video_surface_retarget_to_main_cmd");
      } catch (error) {
        logPipError("pip-lost-retarget-failed", error);
      }
      await restoreMainWindowForPip();
      setPipHostOwner("main");
      setIsPipActive(false);
      setIsNowPlayingOpen(true);
      showErrorToast(i18next.t("player.pip.return_error"));
    } finally {
      pipTransitionRef.current = false;
    }
  }, [restoreMainWindowForPip]);

  // External destroy/crash: nothing in the PiP document can notify main, so
  // the owner polls for the window's existence and recovers the UI rather
  // than leaving isPipActive (and the hidden Now Playing overlay) latched.
  useEffect(() => {
    if (!isPipActive) return;
    let disposed = false;
    let checking = false;
    const timer = window.setInterval(() => {
      if (disposed || checking) return;
      checking = true;
      void isPipWindowOpen()
        .then((open) => {
          if (disposed || open || !isPipActiveRef.current) return;
          void recoverFromExternalPipClose();
        })
        .catch((error: unknown) => {
          logPipError("pip-window-poll-failed", error, "warn");
        })
        .finally(() => {
          checking = false;
        });
    }, PIP_WINDOW_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isPipActive, recoverFromExternalPipClose]);

  // Music auto-advance while PiP is up: PiP only makes sense for video, and
  // suppressing Now Playing for audio would leave the track invisible.
  useEffect(() => {
    if (isPipActive && !isVideoActive) {
      void returnFromPip();
    }
  }, [isPipActive, isVideoActive, returnFromPip]);

  const returnFromPipRef = useRef<() => void>(() => {});
  useEffect(() => {
    returnFromPipRef.current = () => {
      void returnFromPip();
    };
  }, [returnFromPip]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;

    const track = (promise: Promise<() => void>, label: string): void => {
      void promise
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unsubs.push(unlisten);
        })
        .catch((error: unknown) => {
          logPipError(`${label}-listen-failed`, error, "warn");
        });
    };

    track(
      listen<unknown>(PIP_EVENTS.action, (event) => {
        const raw: unknown = event.payload;
        if (typeof raw !== "object" || raw === null) {
          logPipError("pip-action-invalid", "empty payload", "warn");
          return;
        }
        const { action, payload } = raw as PipActionEvent;
        if (action === undefined) {
          logPipError("pip-action-invalid", "missing action", "warn");
          return;
        }
        // A stale PiP window (failed teardown, post-reload page, or after main
        // already returned) must not drive playback. Return is gated too; its
        // own handler is a no-op when PiP is not active.
        if (!isPipActiveRef.current) {
          logPipError("pip-action-ignored", action, "warn");
          return;
        }
        const audio = AudioController.getInstance();

        switch (action) {
          case "togglePlay":
            void handleTogglePlayRef.current?.();
            break;
          case "prev":
            handlePrevTrackRef.current?.();
            break;
          case "next":
            handleNextTrackRef.current?.();
            break;
          case "seek": {
            const seekPayload = payload;
            if (
              typeof seekPayload !== "number" ||
              !Number.isFinite(seekPayload)
            ) {
              logPipError("pip-action-invalid", "invalid seek payload", "warn");
              break;
            }
            const duration = safePlaybackTime(audio.getDuration());
            const target =
              duration > 0
                ? Math.min(Math.max(0, seekPayload), duration)
                : Math.max(0, seekPayload);
            audio.seek(target);
            break;
          }
          case "setVolume": {
            const volumePayload = payload;
            if (
              typeof volumePayload !== "number" ||
              !Number.isFinite(volumePayload)
            ) {
              logPipError(
                "pip-action-invalid",
                "invalid setVolume payload",
                "warn",
              );
              break;
            }
            const volume = Math.min(1, Math.max(0, volumePayload));
            if (volume > 0 && audio.isMuted()) {
              audio.toggleMute();
            }
            audio.setVolume(volume);
            break;
          }
          case "toggleMute":
            audio.toggleMute();
            break;
          case "return":
            returnFromPipRef.current();
            break;
          default:
            logPipError("pip-action-unknown", action, "warn");
            break;
        }

        if (action !== "seek" && action !== "return") {
          window.setTimeout(() => {
            publishPipStateRef.current();
          }, 0);
        }
      }),
      "pip-action",
    );

    track(
      listen(PIP_EVENTS.closeRequested, () => {
        if (!isPipActiveRef.current) return;
        returnFromPipRef.current();
      }),
      "pip-close-requested",
    );

    track(
      listen(PIP_EVENTS.ready, () => {
        publishPipStateRef.current();
      }),
      "pip-ready",
    );

    return () => {
      disposed = true;
      unsubs.forEach((unlisten) => {
        unlisten();
      });
    };
  }, []);

  useEffect(() => {
    if (!isPipActive) return;
    publishPipState();
    const timer = window.setInterval(publishPipState, PIP_STATE_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [isPipActive, publishPipState]);

  // Queue drawer state lives at App level: the pane is docked in AppShell's
  // content row, not inside the memoized PlayerBar. Both wrappers keep a
  // stable identity (empty-dep useCallback + functional update), so the bar
  // is driven purely by the isQueueOpen prop.
  const stableHandleToggleQueue = useCallback(() => {
    setIsQueueOpen((prev) => !prev);
  }, []);

  // Slice 1 (B/C): the ONE owner of the fullscreen player-bar visibility
  // policy (one state, one 1000ms timer). It lives here because App owns both
  // `isPlayerFullscreen` and the player command context, so the keyboard path,
  // the bar buttons and the pointer path all feed the same instance — no
  // second timer or state anywhere else.
  const { chromeVisible, revealChrome, setMenuOpen } = useFullscreenChrome({
    isFullscreen: isPlayerFullscreen,
  });

  // Cursor auto-hide lives in its own hook (see useAutoHideCursor) so the
  // fullscreen chrome policy and its tests stay untouched. The reveal is
  // bridged through a ref because the hook is instantiated later (it depends
  // on videoMenu), while the player command context needs a stable callback.
  const revealCursorRef = useRef<() => void>(() => {});
  const combinedActivity = useCallback(() => {
    revealChrome();
    revealCursorRef.current();
  }, [revealChrome]);

  // The Media Information dialog suspends the fullscreen auto-hide through the
  // SAME seam as the video menu: open = reveal + suspend, close = FRESH 1000 ms
  // countdown. It is derived from the one dialog open-state, so there is no
  // second timer, no second owner, and no playback/fullscreen state touched.
  useEffect(() => {
    setMenuOpen(isMediaInfoOpen);
  }, [isMediaInfoOpen, setMenuOpen]);

  // Real (OS) fullscreen, React -> window. Skipped on the very first commit so
  // a launch into a normal window does not fire a pointless IPC, and skipped
  // whenever the value is unchanged. Engine/playback are untouched: this only
  // asks the window manager to change decoration.
  const lastAppliedFullscreenRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastAppliedFullscreenRef.current === isPlayerFullscreen) return;
    lastAppliedFullscreenRef.current = isPlayerFullscreen;
    void applyWindowFullscreen(isPlayerFullscreen);
  }, [isPlayerFullscreen]);

  // Real fullscreen, window -> React. The user can leave fullscreen without
  // React (Esc, F11, the OS window chrome, the taskbar), and Tauri v2 exposes
  // no fullscreen-changed event, so the state is re-read from the window on
  // the events a real transition produces. The disposer ends every listener,
  // and the flag change re-runs the React -> window effect above only when the
  // value actually differs (the ref guard), so this can never ping-pong.
  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | null = null;
    void syncWindowFullscreenState((fullscreen) => {
      if (disposed) return;
      setIsPlayerFullscreen((prev) =>
        prev === fullscreen ? prev : fullscreen,
      );
    }).then((d) => {
      if (disposed) d();
      else dispose = d;
    });
    return () => {
      disposed = true;
      dispose?.();
      dispose = null;
    };
  }, []);
  const stableHandleCloseQueue = useCallback(() => {
    setIsQueueOpen(false);
  }, []);
  useNowPlayingShortcuts({
    isOpen: isNowPlayingOpen,
    onClose: stableHandleCloseNowPlaying,
    isFullscreen: isPlayerFullscreen,
    onExitFullscreen: stableHandleExitFullscreen,
  });

  // Single global player keydown registry (transport, seek, volume, video
  // controls). Escape stays with useNowPlayingShortcuts above — the registry
  // deliberately ignores it. The callbacks are the exact ones the PlayerBar /
  // NowPlaying controls already use, so keyboard and buttons cannot drift.
  // The SAME context object feeds the D2b video context menu: one wiring, two
  // consumers, so a command can never mean different things per surface.
  const playerCommandContext: PlayerCommandContext = {
    audio: AudioController.getInstance(),
    isFullscreen: isPlayerFullscreen,
    toggleFullscreen: stableHandleToggleFullscreen,
    toggleQueue: stableHandleToggleQueue,
    isQueueOpen,
    selectTrack: stableHandleSelectTrack,
    togglePlay: stableHandleTogglePlay,
    next: stableHandleNextTrack,
    previous: stableHandlePrevTrack,
    togglePlayMode: stableHandleTogglePlayMode,
    setPlayMode: handleSetPlayMode,
    // Slice 1 (C): one activity seam for every surface. runPlayerCommand
    // notifies it once per executed command, so a shortcut still fires exactly
    // once and only reveals as a side effect — no second keydown listener and
    // no redefined shortcut.
    onActivity: combinedActivity,
    enterPip: () => {
      void enterPip();
    },
  };
  usePlayerCommands(playerCommandContext);

  // Right-click on the LEGACY HWND video host (event from video_host.rs) still
  // opens the native context menu. Under the in-process libmpv renderer that
  // host is never created (video_host_acquire short-circuits), so the event
  // cannot fire there — this is the legacy path, kept untouched. The current
  // renderer's right-click is the React handler in NowPlayingView.
  useVideoContextMenu({ ctx: playerCommandContext, isVideoActive });


  // Slice 2: the DrPlay video menu. ONE hook owns BOTH entry points (the bar's
  // More button and right-click on the video area), so the entries, the icons,
  // the submenus and the dispatch path cannot drift between them. Its open
  // state drives the chrome suspension that Slice 1 wired to the native-menu
  // promise: `setMenuOpen` reveals + suspends on open and restarts a FRESH
  // 1000ms countdown on close. Both callbacks below are stable, so the
  // memoized NowPlayingView is not invalidated on every App render.
  const videoMenu = useVideoMenu({
    ctx: playerCommandContext,
    isFullscreen: isPlayerFullscreen,
    onMenuOpenChange: setMenuOpen,
  });
  const { open: openVideoMenu } = videoMenu;

  // Cursor auto-hide: only while the NowPlaying overlay shows a video. Suspended
  // while the video menu or Media Info dialog is open. The hook owns the timer,
  // listeners and native cursor visibility; App just feeds it the gates.
  const autoHideCursor = useAutoHideCursor({
    enabled: isNowPlayingOpen && isVideoActive,
    suspended: videoMenu.isOpen || isMediaInfoOpen,
  });
  useEffect(() => {
    revealCursorRef.current = autoHideCursor.revealCursor;
  }, [autoHideCursor.revealCursor]);
  const stableOpenVideoMenuAtPoint = useCallback(
    (x: number, y: number) => {
      openVideoMenu("full", { kind: "point", x, y });
    },
    [openVideoMenu],
  );

  // Player-ui bus: commands that need a React effect instead of an mpv call.
  // Subscribed once (App is the only owner of the dialog/toast surfaces).
  useEffect(() => {
    return onPlayerUi((event) => {
      if (event.kind === "media-info") {
        setIsMediaInfoOpen(true);
        return;
      }
      if (event.kind === "toast") {
        if (event.payload.variant === "success") {
          showSuccessToast(event.payload.message);
        } else {
          showErrorToast(event.payload.message);
        }
      }
    });
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

  // Ordering contract (Slice 2): mpv reads `--wid` only at spawn, so the
  // native video host must exist before the FIRST `mpv_spawn`. Acquiring on
  // the app-startup path — not lazily on first video play — is what makes that
  // true: the host exists even in a session that never plays video, and the
  // engine's own await in startEngine is then a memoized no-op. Fire-and-forget
  // because a missing host degrades to mpv's own window, never to a failed boot.
  useEffect(() => {
    void ensureVideoHostAcquired();
  }, []);

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
      // Re-clicking the active My Drive tab lands on the configured root view
      // (multi-root -> virtual list; single-root -> app root, legacy). A tab
      // SWITCH keeps the currently open folder, like before.
      if (activeTab === tab && tab === TABS.myDrive) {
        const isMultiRoot = rootFolders.length > 1;
        setCurrentFolderId(
          isMultiRoot ? VIRTUAL_ROOT_ID : appRootFolder || ROOT_FOLDER_ID,
        );
        setCurrentFolderName(isMultiRoot ? VIRTUAL_ROOT_NAME : MY_DRIVE_TAB);
        setFolderHistory([]);
      }
      setActiveTab(tab);
    },
    [
      activeTab,
      appRootFolder,
      rootFolders,
      setCurrentFolderId,
      setCurrentFolderName,
      setFolderHistory,
    ],
  );

  return (
    // drplay-host-clear (S4): while the video host is visible this root's
    // background must not paint over the host rect — App.css drops it then.
    <div className="drplay-host-clear relative flex flex-col h-screen overflow-hidden bg-white dark:bg-[#121212] transition-colors duration-300">
      {/* Login Overlay */}
      <LoginGate
        isLoggedIn={isLoggedIn}
        isAuthHydrated={isAuthHydrated}
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
        isHydrated={isHydrated}
        appRootFolder={appRootFolder}
        showFolderSelection={showFolderSelection}
        token={accessToken}
        rootFolders={rootFolders}
        onCommitRoots={commitRootFolders}
        onDone={() => {
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
        isOpen={isNowPlayingOpen && !isPipActive}
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        onTogglePlay={stableHandleTogglePlay}
        onNextTrack={stableHandleNextTrack}
        onPrevTrack={stableHandlePrevTrack}
        playMode={playMode}
        onTogglePlayMode={stableHandleTogglePlayMode}
        onBack={stableHandleCloseNowPlaying}
        token={accessToken}
        isShellLocked={isShellLocked(
          isLoggedIn,
          appRootFolder,
          showFolderSelection,
        )}
        isFullscreen={isPlayerFullscreen}
        onToggleFullscreen={stableHandleToggleFullscreen}
        onOpenPlayerMenu={videoMenu.open}
        onOpenVideoMenuAt={stableOpenVideoMenuAtPoint}
        chromeVisible={chromeVisible}
        onRevealChrome={revealChrome}
      />

      {/* Slice 2: the one video menu, portaled to <body> like every DrPlay
          menu. Rendered here (App owns the state) but positioned against the
          anchor the caller measured, so it is the SAME component whether the
          bar button or a right-click opened it. */}
      <VideoMenu
        isOpen={videoMenu.isOpen}
        entries={videoMenu.entries}
        anchorPoint={videoMenu.anchorPoint}
        buttonRect={videoMenu.buttonRect}
        trigger={videoMenu.trigger}
        onSelect={videoMenu.select}
        onClose={videoMenu.close}
      />

      {/* Media Information dialog (D2b). It is a React overlay painted ABOVE
          the still-rendering video — the DComp video composites BELOW the
          webview, so the host no longer hides for it. The dialog's translucent
          backdrop dims the video. Its open-state also suspends the floating
          bar's auto-hide through the menu seam (effect above). Keyed by
          open-state so every open starts from a fresh (loading) component — no
          stale-data frame. */}
      <MediaInfoDialog
        key={isMediaInfoOpen ? "media-info-open" : "media-info-closed"}
        open={isMediaInfoOpen}
        onClose={handleCloseMediaInfo}
      />
    </div>
  );
}

export default App;
