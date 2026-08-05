import { useEffect } from "react";

export interface UseKeyboardShortcutsParams {
  onNextTrack: (isAutoSkip?: boolean) => void;
  onPrevTrack: () => void;
  onTogglePlay: () => void;
  onTogglePlayMode: () => void;
}

// Global transport shortcuts (space/n/p/s), only active while the PlayerBar
// is mounted. Seek (arrow) and volume (arrow/m) keys live in SeekBar /
// VolumeSlider next to the state they own, so each handler touches only its
// local component (PLAN v2 — render-critical isolation).
export function useKeyboardShortcuts({
  onNextTrack,
  onPrevTrack,
  onTogglePlay,
  onTogglePlayMode,
}: UseKeyboardShortcutsParams) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl?.tagName === "INPUT" ||
        activeEl?.tagName === "TEXTAREA" ||
        activeEl?.isContentEditable
      )
        return;

      switch (e.key) {
        case "n":
        case "N":
          e.preventDefault();
          onNextTrack(false);
          break;
        case "p":
        case "P":
          e.preventDefault();
          onPrevTrack();
          break;
        case "s":
        case "S":
          e.preventDefault();
          onTogglePlayMode();
          break;
        case " ":
          e.preventDefault();
          onTogglePlay();
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onNextTrack, onPrevTrack, onTogglePlay, onTogglePlayMode]);
}
