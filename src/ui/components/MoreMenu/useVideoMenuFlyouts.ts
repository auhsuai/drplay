import { useRef, useState } from "react";
import type React from "react";
import type { RefObject } from "react";
import { hasHoverPointer } from "./menuIcons";
import { focusMenuItemAt, getEnabledMenuItems } from "./menuFocus";

interface UseVideoMenuFlyoutsParams {
  isOpen: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
}

export interface VideoMenuFlyouts {
  openChain: readonly string[];
  cascadeSideRef: RefObject<"left" | "right" | null>;
  hoverOpensSubmenu: boolean;
  closeSubmenu: () => void;
  collapseTo: (chain: readonly string[]) => void;
  toggleSubmenu: (id: string, chain: readonly string[]) => void;
  openSubmenu: (id: string, chain: readonly string[]) => void;
  handleKeyDown: (
    e: React.KeyboardEvent<HTMLDivElement>,
    closeMenu: () => void,
  ) => void;
}

/**
 * The video menu's flyout state machine: which chain of submenus is open, the
 * cascade direction, and every way the chain changes (hover, click, keyboard).
 *
 * `closeMenu` is a PARAMETER of the returned key handler rather than a param of
 * this hook on purpose: the menu's own close comes from `useMoreMenuEvents`,
 * which in turn needs this hook's `closeSubmenu` — passing it here would close
 * that cycle.
 */
export function useVideoMenuFlyouts({
  isOpen,
  menuRef,
}: UseVideoMenuFlyoutsParams): VideoMenuFlyouts {
  /**
   * The OPEN CHAIN from the root, as ids (`[audio, audio-track]` = the Audio
   * section's flyout is open and, inside it, the audio-track flyout). A chain
   * (not a single id) is required because the model's tree is three levels deep
   * (`full > audio > audio-track > tracks`), and every level must stay visible
   * while its child is. Opening an item REPLACES the chain from that item's own
   * depth, which closes its sibling at the same level — the native menu's rule.
   */
  const [openChain, setOpenChain] = useState<readonly string[]>([]);
  const lastOpenId: string | null = openChain[openChain.length - 1] ?? null;
  /**
   * Hover opens a flyout only on a pointer-driven device; a touch tap keeps
   * click-to-toggle. Read once per open (a matchMedia query, not a listener),
   * so the prop is simply absent where hovering must not open anything.
   */
  const hoverOpensSubmenu = hasHoverPointer();

  /**
   * Which way the cascade runs, decided ONCE by the first flyout and inherited
   * by every deeper level — the native rule, and the reason it matters: a
   * left-opening submenu whose own submenu flipped back to the right landed on
   * top of the root panel, zig-zagging down the tree.
   *
   * A ref, not state: `positionFlyout` runs from a ref callback during commit,
   * so writing state there would re-render and re-fire every ref.
   */
  const cascadeSideRef = useRef<"left" | "right" | null>(null);

  const closeSubmenu = () => {
    setOpenChain([]);
    cascadeSideRef.current = null;
  };

  // Closing the menu must collapse every flyout. React's documented "adjust
  // state while rendering" pattern (the same one useMenuPlaylists uses) instead
  // of an effect, so reopening can never show a stale submenu and no cascading
  // render is introduced.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (!isOpen && openChain.length > 0) {
      setOpenChain([]);
    }
  }

  // Both item roles (a checkable row is menuitemcheckbox), matched by the id
  // the model gave the entry.
  const entryEl = (id: string): HTMLElement | null | undefined =>
    menuRef.current?.querySelector<HTMLElement>(
      `[data-menu-id="${CSS.escape(id)}"]`,
    );

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>,
    closeMenu: () => void,
  ) => {
    const active = e.target as HTMLElement;
    const entryId = active.dataset["menuId"] ?? null;
    // aria-haspopup="menu" marks a submenu parent at any nesting depth.
    const isParent = active.getAttribute("aria-haspopup") === "menu";

    if (e.key === "Escape") {
      // APG submenu-first order (same as MoreMenu): the first Escape closes
      // only the DEEPEST open submenu and returns focus to its parent menuitem;
      // the next one closes the whole menu.
      if (lastOpenId !== null) {
        e.stopPropagation();
        closeSubmenu();
        entryEl(lastOpenId)?.focus();
        return;
      }
      e.stopPropagation();
      closeMenu();
      return;
    }

    if (e.key === "ArrowRight" && isParent && entryId !== null) {
      e.preventDefault();
      // data-depth is the row's own nesting level, so the chain to rebuild is
      // exactly the currently-open ids above it.
      const depth = Number.parseInt(active.dataset["depth"] ?? "0", 10);
      toggleSubmenu(entryId, openChain.slice(0, depth));
      return;
    }
    if (e.key === "ArrowLeft" && openChain.length > 0) {
      e.preventDefault();
      const closing = lastOpenId as string;
      closeSubmenu();
      entryEl(closing)?.focus();
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
    e.preventDefault();
    const enabled = getEnabledMenuItems(menuRef.current);
    if (enabled.length === 0) return;
    const current = enabled.indexOf(active);
    if (e.key === "ArrowDown") {
      focusMenuItemAt(menuRef.current, current < 0 ? 0 : current + 1);
    } else if (e.key === "ArrowUp") {
      focusMenuItemAt(menuRef.current, current < 0 ? -1 : current - 1);
    } else if (e.key === "Home") {
      focusMenuItemAt(menuRef.current, 0);
    } else {
      focusMenuItemAt(menuRef.current, enabled.length - 1);
    }
  };

  /**
   * Toggle the submenu of `id`, whose ancestor chain is `chain` (so a nested
   * toggle rebuilds the WHOLE chain instead of only its own id). Reopening at a
   * depth drops everything below it, which closes the sibling flyouts.
   */
  const toggleSubmenu = (id: string, chain: readonly string[]) => {
    setOpenChain((current) =>
      current[chain.length] === id
        ? current.slice(0, chain.length)
        : [...chain, id],
    );
  };

  /**
   * OPEN (never toggle) the submenu of `id` — the hover path. Re-entering the
   * parent whose flyout is already open must leave it open, so `toggleSubmenu`
   * is deliberately not reused here. It never dispatches a command either:
   * hover only reveals the children.
   */
  const openSubmenu = (id: string, chain: readonly string[]) => {
    // Already the open flyout at this depth. Nothing to do — and returning
    // before any state write also keeps a pointer drifting inside the row from
    // re-rendering.
    if (openChain[chain.length] === id) return;
    setOpenChain([...chain, id]);
  };

  /**
   * Hovering a row that has NO submenu closes the flyouts at its own level and
   * below, keeping the ones above it. `chain` is the ancestor chain of that row,
   * so a leaf in the root collapses everything while a leaf inside the Audio
   * flyout only drops Audio's own children — the pointer can never leave a
   * flyout half-open just by crossing a row that has no submenu.
   */
  const collapseTo = (chain: readonly string[]) => {
    if (openChain.length <= chain.length) return;
    setOpenChain([...chain]);
  };

  return {
    openChain,
    cascadeSideRef,
    hoverOpensSubmenu,
    closeSubmenu,
    collapseTo,
    toggleSubmenu,
    openSubmenu,
    handleKeyDown,
  };
}
