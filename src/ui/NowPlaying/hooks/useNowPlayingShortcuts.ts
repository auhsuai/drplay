import { useEffect } from "react";

export interface UseNowPlayingShortcutsParams {
  isOpen: boolean;
  onClose: () => void;
  onToggle: () => void;
}

// Global NowPlaying overlay shortcuts (f to toggle, Escape to close).
// Mirrors the guard order of useKeyboardShortcuts / useSeekKeyboard:
// editable focus first, then modifier chords, so typing "f" in a field and
// Ctrl+F search are never stolen. Shift is intentionally NOT treated as a
// blocking modifier so Shift+F (e.key "F") still toggles.
export function useNowPlayingShortcuts({
  isOpen,
  onClose,
  onToggle,
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
  }, [isOpen, onClose, onToggle]);
}
