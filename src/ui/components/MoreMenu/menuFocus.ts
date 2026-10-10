/**
 * Roving-tabindex helpers shared by the portal menus (MoreMenu and the video
 * menu). The items are rendered by several child components, so the roving set
 * is queried from the dropdown at event time (same approach as the dialog
 * focus containment in ImageCropperModal) instead of being threaded through
 * every item caller. Only role="menuitem" entries participate, so an input
 * inside a submenu keeps its own arrow-key behaviour.
 */

/** Both APG menu-item roles: plain rows and checkable rows. */
const MENU_ITEM_SELECTOR = '[role="menuitem"],[role="menuitemcheckbox"]';

/** Enabled items of a menu container, in DOM order. */
export function getEnabledMenuItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  ).filter((item) => item.getAttribute("aria-disabled") !== "true");
}

/**
 * Move focus to the `index`-th enabled item (wrapping). Exactly one item keeps
 * tabIndex=0: aria-disabled entries are pulled out of the roving set even
 * though they keep their DOM position.
 */
export function focusMenuItemAt(root: HTMLElement | null, index: number): void {
  if (!root) return;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  );
  const enabled = items.filter(
    (item) => item.getAttribute("aria-disabled") !== "true",
  );
  if (enabled.length === 0) return;
  const target = enabled[(index + enabled.length) % enabled.length];
  items.forEach((item) => {
    item.tabIndex = item === target ? 0 : -1;
  });
  // preventScroll: the fixed panel may extend past the viewport, and a
  // focus-driven scroll would fire the menus' capture-phase scroll dismissal
  // (useMoreMenuEvents) on the very tick the menu opens.
  target?.focus({ preventScroll: true });
}
