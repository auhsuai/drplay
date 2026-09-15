import { useEffect } from "react";

export interface UseKeyboardShortcutsParams {
  onNextTrack: (isAutoSkip?: boolean) => void;
  onPrevTrack: () => void;
  onTogglePlay: () => void;
  onTogglePlayMode: () => void;
  onToggleQueue: () => void;
}

// Global transport shortcuts (space/n/p/s + Ctrl+Q queue panel), only active
// while the PlayerBar is mounted. Seek (arrow) and volume (arrow/m) keys live
// in SeekBar / VolumeSlider next to the state they own, so each handler
// touches only its local component (PLAN v2 — render-critical isolation).
export function useKeyboardShortcuts({
  onNextTrack,
  onPrevTrack,
  onTogglePlay,
  onTogglePlayMode,
  onToggleQueue,
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

      // Auto-repeat must not spam a discrete transport toggle (holding space
      // would flicker play/pause, holding n/p would skip through the queue,
      // s would spin the play mode). Placed BEFORE the Ctrl+Q branch so a held
      // Ctrl+Q cannot spam the queue toggle; the seek/volume arrows
      // deliberately keep repeat (see useSeekKeyboard).
      if (e.repeat) return;

      // Ctrl+Q (Cmd+Q on mac) toggles the queue panel. Alt is excluded so
      // AltGr-adjacent layouts cannot trip it; the plain keys below keep
      // their modifier-free behavior.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "q"
      ) {
        e.preventDefault();
        onToggleQueue();
        return;
      }

      // Any other Ctrl/Meta/Alt chord belongs to the app/webview, not the
      // player (Ctrl+S save, Ctrl+N/P navigation, Ctrl+Space IME...) — same
      // rule as useSeekKeyboard / useNowPlayingShortcuts. Must sit AFTER the
      // Ctrl+Q branch above so the queue shortcut keeps working.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

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
  }, [onNextTrack, onPrevTrack, onTogglePlay, onTogglePlayMode, onToggleQueue]);
}
