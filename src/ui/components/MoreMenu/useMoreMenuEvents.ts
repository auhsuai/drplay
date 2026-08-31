import { useCallback, useEffect } from "react";
import type { RefObject } from "react";
import { useClickOutside } from "../../../hooks/useClickOutside";

interface UseMoreMenuEventsParams {
  isMenuOpen: boolean | undefined;
  setIsOpen: (open: boolean) => void;
  onClose?: (() => void) | undefined;
  menuRef: RefObject<HTMLDivElement | null>;
  dropdownRef: RefObject<HTMLDivElement | null>;
  // Portal overlays stacked above the dropdown — the SAME state sources the
  // hardware-back handler in MoreMenu.tsx reads, so Escape mirrors its LIFO
  // priority exactly.
  showDownloadDialog: boolean;
  showDeleteConfirm: boolean;
  showMoveScreen: boolean;
  setShowDownloadDialog: (open: boolean) => void;
  setShowDeleteConfirm: (open: boolean) => void;
  setShowMoveScreen: (open: boolean) => void;
}

export function useMoreMenuEvents({
  isMenuOpen,
  setIsOpen,
  onClose,
  menuRef,
  dropdownRef,
  showDownloadDialog,
  showDeleteConfirm,
  showMoveScreen,
  setShowDownloadDialog,
  setShowDeleteConfirm,
  setShowMoveScreen,
}: UseMoreMenuEventsParams): void {
  const closeMenu = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose, setIsOpen]);

  // Outside mousedown closes the menu when the target is outside both the
  // trigger wrapper and the (portal-rendered) dropdown.
  useClickOutside([menuRef, dropdownRef], closeMenu, isMenuOpen === true);

  useEffect(() => {
    const handleScroll = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Mirror the hardware-back LIFO order in MoreMenu.tsx handleBack:
      // peel only the topmost portal dialog per press and leave the lower
      // layers (including this dropdown) untouched until their turn. None of
      // the dialogs handle a document-level Escape themselves, so this
      // listener is the single owner of that key while any overlay is open.
      if (showDownloadDialog) {
        setShowDownloadDialog(false);
        return;
      }
      if (showDeleteConfirm) {
        setShowDeleteConfirm(false);
        return;
      }
      if (showMoveScreen) {
        setShowMoveScreen(false);
        return;
      }
      closeMenu();
    };

    // Scroll-to-close only applies to the dropdown itself; the Escape
    // listener must stay armed whenever ANY overlay is open (the real
    // item-click flow closes the dropdown before opening its dialog, so a
    // dialog can be on screen while isMenuOpen is false).
    if (isMenuOpen) {
      window.addEventListener("scroll", handleScroll, true);
    }
    const isAnyOverlayOpen =
      isMenuOpen === true ||
      showDownloadDialog ||
      showDeleteConfirm ||
      showMoveScreen;
    if (isAnyOverlayOpen) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    isMenuOpen,
    showDownloadDialog,
    showDeleteConfirm,
    showMoveScreen,
    closeMenu,
    setShowDownloadDialog,
    setShowDeleteConfirm,
    setShowMoveScreen,
  ]);
}
