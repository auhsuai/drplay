import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NativeMenuEntry, NativeMenuItem } from "../../../lib/nativeMenu";
import { MoreMenuItem } from "./MoreMenuItem";
import { VIDEO_MENU_ITEM_CLASS } from "./constants";
import { iconForEntry, isQueueItem } from "./menuIcons";
import { focusMenuItemAt } from "./menuFocus";
import { getContextMenuStyle, shouldOpenUpwards } from "./menuPositioning";
import { positionFlyout } from "./positionFlyout";
import {
  NO_GLYPH_ICON_CLASS,
  QUEUE_CURRENT_CLASS,
  QUEUE_SCROLL_CLASS,
  ROOT_PANEL_CLASS,
  SEPARATOR_CLASS,
  SUBMENU_PANEL_CLASS,
} from "./menuStyles";
import { useMoreMenuEvents } from "./useMoreMenuEvents";
import { useVideoMenuFlyouts } from "./useVideoMenuFlyouts";

/**
 * Slice 2: the video menu, rendered with the DrPlay design system.
 *
 * ONE component serves BOTH entry points — the video bar's More button and
 * right-click on the video area. `anchorPoint` (pointer) vs `buttonRect`
 * (trigger) is the ONLY difference: entries, icons, submenu behaviour, keyboard
 * support and the dispatch callback are shared, and the tree always comes from
 * `menuModel.buildContextMenuModel("full", …)`.
 *
 * Reused from the MoreMenu shell, never re-invented: `MoreMenuItem` as the item
 * renderer, `MENU_ITEM_BASE_CLASS` for row styling, `getContextMenuStyle` /
 * `shouldOpenUpwards` for clamped positioning, and `useMoreMenuEvents` for
 * dismissal (outside mousedown / scroll / resize / document Escape). The portal
 * + panel classes match MoreMenu's dropdown, except the z-index (one step
 * higher here: the panel must paint above the z-[9999] NowPlaying overlay).
 *
 * Icons are the one thing the model does not carry, so they resolve HERE in a
 * single id -> Lucide map instead of being threaded through menuModel.
 */

export interface VideoMenuProps {
  isOpen: boolean;
  /** menuModel output for the "full" section — the single source of truth. */
  entries: NativeMenuEntry[];
  /** Right-click anchor (viewport CSS px). Null for the button path. */
  anchorPoint: { x: number; y: number } | null;
  /** More-button anchor (the measured trigger rect). Null for right-click. */
  buttonRect: DOMRect | null;
  /**
   * The trigger element when the menu was opened from the More button, so an
   * outside mousedown ON the trigger is not treated as a dismissal (the
   * trigger toggles itself). Null on the right-click path.
   */
  trigger?: HTMLElement | null | undefined;
  /** Dispatch a picked id through the existing command path. */
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function VideoMenu({
  isOpen,
  entries,
  anchorPoint,
  buttonRect,
  trigger = null,
  onSelect,
  onClose,
}: VideoMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  // The click-outside exclusion has to see the CURRENT trigger; the mirror runs
  // in an effect because the ref is only ever read from a listener.
  const triggerRef = useRef<HTMLElement | null>(trigger);
  useEffect(() => {
    triggerRef.current = trigger;
  }, [trigger]);
  const {
    openChain,
    cascadeSideRef,
    hoverOpensSubmenu,
    closeSubmenu,
    collapseTo,
    toggleSubmenu,
    openSubmenu,
    handleKeyDown,
  } = useVideoMenuFlyouts({ isOpen, menuRef });

  const { closeMenu } = useMoreMenuEvents({
    isMenuOpen: isOpen,
    setIsOpen: onClose,
    menuRef: triggerRef,
    dropdownRef: menuRef,
    setShowPlaylistsSubmenu: closeSubmenu,
    // Focus return is owned by useVideoMenu (it holds the trigger element).
    restoreFocus: false,
  });

  // APG: focus the first item whenever the menu opens, from either entry point.
  // The rows arrive one tick after the panel (the snapshot is async), so this
  // runs on `entries` too, not only on the open transition.
  useEffect(() => {
    if (!isOpen) return;
    focusMenuItemAt(menuRef.current, 0);
  }, [isOpen, entries]);

  // The queue box shows ~5 of up to 50 rows, so put the track being played in
  // view when the submenu appears — centred, the way the row order reads.
  // Queried by attribute instead of a ref so the recursive renderer needs no
  // ref plumbing; `?.()` because jsdom implements no scrollIntoView.
  // `openChain` is a dependency because the flyout only exists once it is open —
  // on the menu's own open the box is not mounted yet.
  useEffect(() => {
    if (!isOpen) return;
    const box =
      menuRef.current?.querySelector<HTMLElement>("[data-queue-list]");
    const current = box?.querySelector<HTMLElement>('[aria-checked="true"]');
    current?.scrollIntoView({ block: "center" });
  }, [isOpen, entries, openChain]);

  if (!isOpen) return null;

  const openUpwards = buttonRect !== null && shouldOpenUpwards(buttonRect);

  const renderItems = (list: NativeMenuEntry[], chain: readonly string[]) => {
    // The queue rows arrive as ONE run at the head of the list; boxing that run
    // keeps a 50-item queue from making the flyout taller than the screen.
    // Everything after it renders exactly as before.
    const queueEnd = list.findIndex((entry) => !isQueueItem(entry));
    const queueCount = queueEnd === -1 ? list.length : queueEnd;
    const rest = list.slice(queueCount);

    return [
      ...(queueCount > 0
        ? [
            <div
              key="queue"
              className={QUEUE_SCROLL_CLASS}
              data-queue-list="true"
            >
              {list
                .slice(0, queueCount)
                .filter(isQueueItem)
                .map((entry, index) => renderItem(entry, index, chain))}
            </div>,
          ]
        : []),
      ...rest.map((entry, index) =>
        entry.kind === "separator" ? (
          <div
            key={`separator-${String(queueCount + index)}`}
            role="separator"
            className={SEPARATOR_CLASS}
          />
        ) : (
          renderItem(entry, queueCount + index, chain)
        ),
      ),
    ];
  };

  const renderItem = (
    entry: NativeMenuItem,
    index: number,
    chain: readonly string[],
  ) => {
    const depth = chain.length;
    const key = `item-${entry.id}-${String(index)}`;
    const disabled = entry.enabled === false;
    const hasChildren = (entry.children?.length ?? 0) > 0;

    // A queue row — the one place the check column is NOT how "selected" is shown.
    const queue = isQueueItem(entry);
    // A checked row shows the checkmark in the leading slot — the native menu's
    // check column, and the only visual cue a DrPlay row has for it. The queue is
    // the deliberate exception: up to 50 rows share one icon, so the column is
    // blank there and the track being played is called out by QUEUE_CURRENT_CLASS
    // instead. Every OTHER checked row (audio/subtitle track, mute, repeat mode)
    // keeps its checkmark exactly as before.
    const Icon =
      entry.checked === true && !queue ? Check : iconForEntry(entry.id);
    // A queue row keeps the icon column but hides the glyph — checked or not, so
    // the labels stay in one straight line down the list. Spread (not
    // `iconClassName={undefined}`) because the project runs
    // exactOptionalPropertyTypes, and leaving the prop off keeps MoreMenuItem's
    // own default instead of duplicating it here.
    const iconProps = queue ? { iconClassName: NO_GLYPH_ICON_CLASS } : {};
    // Derived from the entry's own `checked` (the model's `currentTrackId`
    // comparison), never from local state, so the highlight cannot go stale.
    const rowClassName =
      queue && entry.checked === true
        ? `${VIDEO_MENU_ITEM_CLASS} ${QUEUE_CURRENT_CLASS}`
        : VIDEO_MENU_ITEM_CLASS;

    if (!hasChildren) {
      return (
        <div
          key={key}
          className="relative"
          onMouseEnter={
            // Crossing a row WITHOUT a submenu collapses the flyouts below it
            // (Playlist -> Media info must close the playlist list), instead of
            // leaving one hanging over the video.
            hoverOpensSubmenu
              ? () => {
                  collapseTo(chain);
                }
              : undefined
          }
        >
          <MoreMenuItem
            icon={Icon}
            label={entry.label}
            menuId={entry.id}
            checked={entry.checked}
            title={entry.shortcut}
            disabled={disabled}
            className={rowClassName}
            {...iconProps}
            trailing={
              entry.detail !== undefined ? (
                // The episode number of a queue row. Right-aligned in the
                // TRAILING slot, not appended to the label: the label is
                // truncated from the right, so anything added there would be the
                // first thing cut off.
                <span className="ml-auto pl-2 text-xs tabular-nums opacity-50">
                  {entry.detail}
                </span>
              ) : undefined
            }
            onClick={(e) => {
              e.stopPropagation();
              onSelect(entry.id);
            }}
          />
        </div>
      );
    }

    const expanded = openChain[depth] === entry.id;

    return (
      <div
        key={key}
        className="relative"
        onMouseEnter={
          // Hovering the parent opens the flyout like a desktop media menu.
          // The handler sits on the WRAPPER (row + flyout are one subtree), so
          // moving from the row into its own flyout never re-enters/left a
          // boundary — the flyout cannot close halfway through the move. A
          // disabled parent stays shut, matching APG (aria-disabled items do
          // not activate) and the click path, which MoreMenuItem blocks too.
          hoverOpensSubmenu && !disabled
            ? () => {
                openSubmenu(entry.id, chain);
              }
            : undefined
        }
      >
        <MoreMenuItem
          icon={Icon}
          label={entry.label}
          menuId={entry.id}
          checked={entry.checked}
          depth={depth}
          expanded={expanded}
          title={entry.shortcut}
          disabled={disabled}
          className={VIDEO_MENU_ITEM_CLASS}
          {...iconProps}
          trailing={
            // ml-auto, NOT justify-between on the row: justify-between spread
            // the icon / label / chevron apart and pushed every parent label to
            // the middle of the panel. The auto margin pins the chevron to the
            // right edge and leaves the label beside its icon.
            <ChevronRight className="ml-auto w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
          }
          onClick={(e) => {
            e.stopPropagation();
            toggleSubmenu(entry.id, chain);
          }}
        />
        {expanded && entry.children !== undefined && (
          // A click inside the flyout bubbles to the root panel, whose onClick
          // stops propagation (the same job PlaylistsSubmenu's parent does), so
          // this panel needs no handler of its own — and a role="menu" element
          // with a click handler would be an a11y violation anyway.
          <div
            role="menu"
            data-submenu="true"
            aria-label={entry.label}
            // Position is measured, not declared: see positionFlyout. It runs on
            // every commit (ref callbacks re-fire when their identity changes)
            // and is idempotent, so a re-render re-writes the same two values.
            ref={(panel) => {
              if (panel !== null) positionFlyout(panel, depth, cascadeSideRef);
            }}
            className={SUBMENU_PANEL_CLASS}
          >
            {renderItems(entry.children, [...chain, entry.id])}
          </div>
        )}
      </div>
    );
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("player.menu.video_menu")}
      tabIndex={-1}
      className={ROOT_PANEL_CLASS}
      style={getContextMenuStyle({ anchorPoint, buttonRect, openUpwards })}
      onClick={(e) => {
        e.stopPropagation();
      }}
      onMouseLeave={() => {
        // Leaving the whole menu (panel AND every flyout — the flyouts are
        // DOM descendants of this panel, so React's leave only fires once the
        // pointer is outside the entire subtree) collapses the chain, so no
        // flyout is ever left hanging over the video. The menu itself stays:
        // closing it is the outside-mousedown path's job. Moving from one
        // parent row to another never reaches here (both are inside), which is
        // what makes the swap instant instead of close-then-reopen (no flicker).
        if (openChain.length > 0) closeSubmenu();
      }}
      onKeyDown={(e) => {
        handleKeyDown(e, closeMenu);
      }}
      onContextMenu={(e) => {
        // Never a Windows/browser menu from inside our own menu.
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      {renderItems(entries, [])}
    </div>,
    document.body,
  );
}
