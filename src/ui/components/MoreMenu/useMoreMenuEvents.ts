import { useCallback, useEffect } from "react";
import type { RefObject } from "react";
import { useClickOutside } from "../../../hooks/useClickOutside";

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
  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setShowPlaylistsSubmenu(false);
    onClose?.();
  }, [onClose, setIsOpen, setShowPlaylistsSubmenu]);

  // Outside mousedown closes the menu when the target is outside both the
  // trigger wrapper and the (portal-rendered) dropdown.
  useClickOutside([menuRef, dropdownRef], closeMenu, isMenuOpen === true);

  useEffect(() => {
    const handleScroll = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeMenu();
      }
    };

    if (isMenuOpen) {
      window.addEventListener("scroll", handleScroll, true);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen, closeMenu]);
}
