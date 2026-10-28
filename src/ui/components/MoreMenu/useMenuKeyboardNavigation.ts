import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import {
  focusMenuItemAt as focusItemAt,
  getEnabledMenuItems as getEnabledItems,
} from "./menuFocus";

/**
 * Which row the next "open" should focus: the trigger's ArrowDown/ArrowUp asks
 * for the first/last row; a plain click leaves the default ("first").
 */
export type PendingMenuFocus = "first" | "last";

interface UseMenuKeyboardNavigationParams {
  /**
   * `isOpen || forceOpen` — the effect below re-runs on the open transition,
   * which is exactly when APG asks for "focus moves into the menu". Optional
   * because `isOpen || forceOpen` is `boolean | undefined` at the call site.
   */
  isMenuOpen: boolean | undefined;
  dropdownRef: RefObject<HTMLDivElement | null>;
  /** From useMoreMenuEvents: owns the focus-restore policy (do not duplicate). */
  closeMenu: () => void;
  showPlaylistsSubmenu: boolean;
  setShowPlaylistsSubmenu: (value: boolean) => void;
}

export interface MenuKeyboardNavigation {
  /** Ref-backed setter (no re-render) for MoreMenuTrigger.onArrowOpen. */
  setPendingFocus: (position: PendingMenuFocus) => void;
  getEnabledMenuItems: () => HTMLElement[];
  focusMenuItemAt: (index: number) => void;
  handleMenuKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Keyboard support for the portal menu (APG menu button): the items are
 * rendered by several child components, so the roving set is queried from the
 * dropdown at event time (same approach as the dialog focus containment in
 * ImageCropperModal) instead of threading a prop through every item caller.
 * Only role="menuitem"/"menuitemcheckbox" entries participate, so the playlists
 * search input keeps its own arrow-key behavior.
 *
 * Roving focus is shared with the video menu (menuFocus.ts) so both menus
 * navigate identically.
 */
export function useMenuKeyboardNavigation({
  isMenuOpen,
  dropdownRef,
  closeMenu,
  showPlaylistsSubmenu,
  setShowPlaylistsSubmenu,
}: UseMenuKeyboardNavigationParams): MenuKeyboardNavigation {
  const pendingFocusRef = useRef<PendingMenuFocus>("first");

  const setPendingFocus = useCallback((position: PendingMenuFocus): void => {
    pendingFocusRef.current = position;
  }, []);

  // Stable across renders on purpose: the focus-on-open effect keys off these
  // two functions, and a fresh identity on every render (vitest does not run
  // the React Compiler) would yank focus back to the first row after any
  // re-render — e.g. when the playlists list finishes loading.
  const getEnabledMenuItems = useCallback(
    (): HTMLElement[] => getEnabledItems(dropdownRef.current),
    // Stable `useRef` handle owned by the caller, passed in as a prop. ESLint
    // cannot prove it is stable, and listing it cannot cause a re-run.
    [dropdownRef],
  );

  const focusMenuItemAt = useCallback(
    (index: number): void => {
      focusItemAt(dropdownRef.current, index);
    },
    [dropdownRef],
  );

  // APG: focus moves to the first item whenever the menu opens — trigger
  // click, optional trigger ArrowDown/Up, or the SongCard context menu.
  useEffect(() => {
    if (!isMenuOpen) return;
    const position = pendingFocusRef.current;
    pendingFocusRef.current = "first";
    focusMenuItemAt(position === "last" ? -1 : 0);
  }, [isMenuOpen, focusMenuItemAt]);

  const handleMenuKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === "Escape") {
        // Layer order (R3): the container is the innermost handler on this
        // path, so the document listener in useMoreMenuEvents must not close
        // the menu a second time.
        e.stopPropagation();
        if (showPlaylistsSubmenu) {
          // APG submenu-first order (P2-08-6): the first Escape closes only
          // the submenu and returns focus to its parent menuitem; the next
          // Escape closes the menu (closeMenu restores the trigger focus per
          // P2-08-3).
          setShowPlaylistsSubmenu(false);
          dropdownRef.current
            ?.querySelector<HTMLElement>('[aria-haspopup="menu"]')
            ?.focus();
          return;
        }
        closeMenu();
        return;
      }
      if (
        e.key !== "ArrowDown" &&
        e.key !== "ArrowUp" &&
        e.key !== "Home" &&
        e.key !== "End"
      ) {
        return;
      }
      // Arrow keys belong to the text cursor while typing in the playlists
      // search box — never to roving focus.
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      e.preventDefault();
      const items = getEnabledMenuItems();
      if (items.length === 0) return;
      const current = items.indexOf(e.target as HTMLElement);
      if (e.key === "ArrowDown") {
        focusMenuItemAt(current < 0 ? 0 : current + 1);
      } else if (e.key === "ArrowUp") {
        focusMenuItemAt(current < 0 ? items.length - 1 : current - 1);
      } else if (e.key === "Home") {
        focusMenuItemAt(0);
      } else {
        focusMenuItemAt(items.length - 1);
      }
    },
    [
      closeMenu,
      dropdownRef,
      focusMenuItemAt,
      getEnabledMenuItems,
      setShowPlaylistsSubmenu,
      showPlaylistsSubmenu,
    ],
  );

  return {
    setPendingFocus,
    getEnabledMenuItems,
    focusMenuItemAt,
    handleMenuKeyDown,
  };
}
