import { useCallback, useEffect, useState } from "react";
import { captureError } from "../utils/errorLog";
import {
  LS_BACKGROUND_PLAYBACK,
  loadBackgroundPlaybackState,
} from "../appUiState";
import { loadSidebarOpenState } from "../utils/sidebarState";
import { useBackgroundPlayback } from "./useBackgroundPlayback";

/**
 * App-level overlay/UI state, verbatim from App.tsx: trash screen, folder
 * selection, sidebar, NowPlaying overlay, and the background-playback
 * preference (state + persistence + the mobile pause-on-hidden wiring).
 */
export function useAppUiState() {
  const [showTrashScreen, setShowTrashScreen] = useState(false);
  const [showFolderSelection, setShowFolderSelection] = useState(false);
  // Lazy initializer (read once on mount, no default-flash): stored state is
  // kept across launches; first launch (no key) defaults to OPEN on desktop
  // and CLOSED on mobile (closed mobile default keeps the hardware-back
  // sidebar handler from swallowing the first back press). 'false' is the
  // only collapsing value; anything else (missing/corrupt) opens — see
  // sidebarState.
  const [isSidebarOpen, setIsSidebarOpen] = useState(loadSidebarOpenState);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);
  // Mobile-only (Task 3 mobile-polish): "Chạy nhạc nền" — when OFF, playback
  // pauses while the app is hidden. The key is persisted on both platforms.
  const [backgroundPlayback, setBackgroundPlayback] = useState(
    loadBackgroundPlaybackState,
  );
  useBackgroundPlayback(backgroundPlayback);

  const onExpandNowPlaying = useCallback(() => {
    setIsNowPlayingOpen((prev) => !prev);
  }, []);

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

  return {
    showTrashScreen,
    setShowTrashScreen,
    showFolderSelection,
    setShowFolderSelection,
    isSidebarOpen,
    setIsSidebarOpen,
    isNowPlayingOpen,
    setIsNowPlayingOpen,
    backgroundPlayback,
    setBackgroundPlayback,
    onExpandNowPlaying,
  };
}
