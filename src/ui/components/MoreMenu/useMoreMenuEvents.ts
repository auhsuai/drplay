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
  // False for the anchor/context-menu paths (SongCard right-click): a mouse
  // gesture opened that menu, so APG focus return does not apply (P2-08-3).
  restoreFocus: boolean;
}

export function useMoreMenuEvents({
  isMenuOpen,
  setIsOpen,
  onClose,
  menuRef,
  dropdownRef,
  setShowPlaylistsSubmenu,
  restoreFocus,
}: UseMoreMenuEventsParams): { closeMenu: () => void } {
  const closeMenu = useCallback(() => {
    // Sample the focused element BEFORE the close unmounts the dropdown.
    // Restore only when the menu owned focus (an item, or the background) so a
    // dialog or control that just received focus keeps it (P2-08-3).
    const active: Element | null = document.activeElement;
    const activeInDropdown =
      active !== null && dropdownRef.current?.contains(active) === true;
    const activeOnDocument =
      active === null ||
      active === document.body ||
      active === document.documentElement;

    setIsOpen(false);
    setShowPlaylistsSubmenu(false);
    onClose?.();

    if (!restoreFocus || (!activeInDropdown && !activeOnDocument)) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
      ?.focus();
  }, [
    dropdownRef,
    menuRef,
    onClose,
    restoreFocus,
    setIsOpen,
    setShowPlaylistsSubmenu,
  ]);

  // Outside mousedown closes the menu when the target is outside both the
  // trigger wrapper and the (portal-rendered) dropdown.
  useClickOutside([menuRef, dropdownRef], closeMenu, isMenuOpen === true);

  useEffect(() => {
    const handleScroll = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };

    // Same policy as scroll (P2-08-4): a resize makes the measured trigger
    // rect stale, so close instead of leaving the menu at old coordinates.
    const handleResize = () => {
      closeMenu();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Layer order (QP-3): the menu is the innermost overlay on this path,
        // so the press stops here — the drawer's window listener must not see
        // it. document-bubble stop blocks the later window-bubble listeners.
        e.stopPropagation();
        closeMenu();
      }
    };

    if (isMenuOpen) {
      window.addEventListener("scroll", handleScroll, true);
      window.addEventListener("resize", handleResize);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen, closeMenu]);

  return { closeMenu };
}
