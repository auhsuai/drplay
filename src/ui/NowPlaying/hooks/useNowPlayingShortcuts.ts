import { useEffect } from "react";

export interface UseNowPlayingShortcutsParams {
  isOpen: boolean;
  onClose: () => void;
  /** Player fullscreen is active (a refinement of the overlay). */
  isFullscreen?: boolean;
  /** Leave fullscreen, staying in the Now Playing overlay. */
  onExitFullscreen?: () => void;
}

// Global NowPlaying overlay Escape handling (layering: fullscreen -> overlay ->
// nothing). F/f moved to the player command registry (PLAYER_FULLSCREEN), so
// this hook is the ONLY Escape owner and cannot fight the registry, which
// deliberately ignores Escape.
//
// Escape peels ONE layer at a time: fullscreen -> overlay -> nothing. A single
// Escape must never close the whole surface from inside fullscreen; that is
// what makes fullscreen escapable without a mouse.
export function useNowPlayingShortcuts({
  isOpen,
  onClose,
  isFullscreen = false,
  onExitFullscreen,
}: UseNowPlayingShortcutsParams): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl?.tagName === "INPUT" ||
        activeEl?.tagName === "TEXTAREA" ||
        activeEl?.isContentEditable
      )
        return;

      if (e.key !== "Escape") return;

      // Deepest layer first. isFullscreen implies the overlay is open, so
      // this needs no separate open check.
      if (isFullscreen && onExitFullscreen) {
        onExitFullscreen();
        return;
      }
      if (isOpen) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, isFullscreen, onExitFullscreen]);
}
