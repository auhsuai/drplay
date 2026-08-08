import { useEffect } from "react";
import type { RefObject } from "react";

interface UseMoreMenuEventsParams {
  isMenuOpen: boolean | undefined;
  setIsOpen: (open: boolean) => void;
  onClose?: (() => void) | undefined;
  menuRef: RefObject<HTMLDivElement | null>;
  dropdownRef: RefObject<HTMLDivElement | null>;
  setShowPlaylistsSubmenu: (value: boolean) => void;
}

export function useMoreMenuEvents({
  isMenuOpen,
  setIsOpen,
  onClose,
  menuRef,
  dropdownRef,
  setShowPlaylistsSubmenu,
}: UseMoreMenuEventsParams): void {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        (!dropdownRef.current ||
          !dropdownRef.current.contains(event.target as Node))
      ) {
        setIsOpen(false);
        setShowPlaylistsSubmenu(false);
        onClose?.();
      }
    };

    const handleScroll = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setIsOpen(false);
      setShowPlaylistsSubmenu(false);
      onClose?.();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setShowPlaylistsSubmenu(false);
        onClose?.();
      }
    };

    if (isMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      window.addEventListener("scroll", handleScroll, true);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen, onClose, setShowPlaylistsSubmenu]);
}
