import { useEffect } from "react";

export interface UseNowPlayingShortcutsParams {
  isOpen: boolean;
  onClose: () => void;
  onToggle: () => void;
  /** Player fullscreen is active (a refinement of the overlay). */
  isFullscreen?: boolean;
  /** Leave fullscreen, staying in the Now Playing overlay. */
  onExitFullscreen?: () => void;
}

// Global NowPlaying overlay shortcuts (f to toggle, Escape to close).
// Mirrors the guard order of useKeyboardShortcuts / useSeekKeyboard:
// editable focus first, then modifier chords, so typing "f" in a field and
// Ctrl+F search are never stolen. Shift is intentionally NOT treated as a
// blocking modifier so Shift+F (e.key "F") still toggles.
//
// Escape peels ONE layer at a time: fullscreen -> overlay -> nothing. A single
// Escape must never close the whole surface from inside fullscreen; that is
// what makes fullscreen escapable without a mouse. Owning this here (rather
// than in a second keydown listener) is why it cannot fight
// useKeyboardShortcuts: there is exactly one Escape handler in the app.
export function useNowPlayingShortcuts({
  isOpen,
  onClose,
  onToggle,
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

      if (e.key === "Escape") {
        // Deepest layer first. isFullscreen implies the overlay is open, so
        // this needs no separate open check.
        if (isFullscreen && onExitFullscreen) {
          onExitFullscreen();
          return;
        }
        if (isOpen) onClose();
        return;
      }

      if (e.key === "f" || e.key === "F") {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.repeat) return;
        onToggle();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, onToggle, isFullscreen, onExitFullscreen]);
}
