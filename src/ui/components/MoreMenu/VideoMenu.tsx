import { useEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  Camera,
  Captions,
  Check,
  ChevronRight,
  Circle,
  Crop,
  Eye,
  FilePlus,
  Film,
  Flag,
  Gauge,
  Info,
  ListMusic,
  ListVideo,
  Maximize,
  MonitorPlay,
  Play,
  Ratio,
  Repeat,
  Scan,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  Speaker,
  Square,
  Subtitles,
  Timer,
  Volume2,
  VolumeX,
  ZoomIn,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NativeMenuEntry, NativeMenuItem } from "../../../lib/nativeMenu";
import { MENU_IDS, MENU_PREFIXES } from "../../../player/menuModel";
import { MoreMenuItem } from "./MoreMenuItem";
import { MENU_ITEM_BASE_CLASS } from "./constants";
import { focusMenuItemAt, getEnabledMenuItems } from "./menuFocus";
import { getContextMenuStyle, shouldOpenUpwards } from "./menuPositioning";
import { useMoreMenuEvents } from "./useMoreMenuEvents";

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

const PANEL_CLASS =
  "fixed z-[10000] w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 flex flex-col transition-all animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none";

/** Mirrors MENU_WIDTH_PX in menuPositioning (both panels are w-60). */
const SUBMENU_WIDTH_PX = 240;

const SEPARATOR_CLASS =
  "my-1 h-px border-t border-gray-100 dark:border-gray-800/60";

/** Exact ids: menu sections, their children, and the PLAYER_* commands. */
const ICONS_BY_ID: Readonly<Record<string, LucideIcon>> = {
  [MENU_IDS.fullAudio]: Volume2,
  [MENU_IDS.fullVideo]: MonitorPlay,
  [MENU_IDS.fullSubtitle]: Captions,
  [MENU_IDS.fullPlayback]: Gauge,
  [MENU_IDS.fullPlaylist]: ListMusic,
  [MENU_IDS.audioTrack]: AudioLines,
  [MENU_IDS.audioDevice]: Speaker,
  [MENU_IDS.audioDelay]: Timer,
  [MENU_IDS.videoTrack]: Film,
  [MENU_IDS.aspect]: Ratio,
  [MENU_IDS.zoom]: ZoomIn,
  [MENU_IDS.crop]: Crop,
  [MENU_IDS.deinterlace]: Sparkles,
  [MENU_IDS.subtitleTrack]: Subtitles,
  [MENU_IDS.secondarySubtitle]: Subtitles,
  [MENU_IDS.addSubtitle]: FilePlus,
  [MENU_IDS.subDelay]: Timer,
  [MENU_IDS.speed]: Gauge,
  [MENU_IDS.chapters]: ListVideo,
  [MENU_IDS.setA]: Flag,
  [MENU_IDS.setB]: Flag,
  [MENU_IDS.clearAb]: Flag,
  [MENU_IDS.repeat]: Repeat,
  PLAYER_PLAY_PAUSE: Play,
  PLAYER_STOP: Square,
  PLAYER_NEXT: SkipForward,
  PLAYER_PREVIOUS: SkipBack,
  PLAYER_FULLSCREEN: Maximize,
  PLAYER_MUTE: VolumeX,
  PLAYER_VOLUME_UP: Volume2,
  PLAYER_VOLUME_DOWN: Volume2,
  PLAYER_SUBTITLE_VISIBLE: Eye,
  PLAYER_FIT_WINDOW: Scan,
  PLAYER_SNAPSHOT: Camera,
  PLAYER_MEDIA_INFO: Info,
  PLAYER_QUEUE_TOGGLE: ListMusic,
  PLAYER_SHUFFLE: Shuffle,
};

/**
 * Prefixes for the generated leaves (track / chapter / device / queue ids). No
 * two prefixes can both match one id, so the first hit is the only hit.
 */
const ICONS_BY_PREFIX: ReadonlyArray<readonly [string, LucideIcon]> = [
  [MENU_PREFIXES.audio, AudioLines],
  [MENU_PREFIXES.device, Speaker],
  [MENU_PREFIXES.video, Film],
  [MENU_PREFIXES.sub, Subtitles],
  [MENU_PREFIXES.secondary, Subtitles],
  [MENU_PREFIXES.chapter, ListVideo],
  [MENU_PREFIXES.speed, Gauge],
  [MENU_PREFIXES.aspect, Ratio],
  [MENU_PREFIXES.zoom, ZoomIn],
  [MENU_PREFIXES.crop, Crop],
  [MENU_PREFIXES.deinterlace, Sparkles],
  [MENU_PREFIXES.subDelay, Timer],
  [MENU_PREFIXES.audioDelay, Timer],
  [MENU_PREFIXES.repeat, Repeat],
  [MENU_PREFIXES.queue, ListMusic],
];

const DEFAULT_ICON: LucideIcon = Circle;

function iconForEntry(id: string): LucideIcon {
  const exact = ICONS_BY_ID[id];
  if (exact) return exact;
  for (const [prefix, Icon] of ICONS_BY_PREFIX) {
    if (id.startsWith(prefix)) return Icon;
  }
  return DEFAULT_ICON;
}

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
  /**
   * The OPEN CHAIN from the root, as ids (`[audio, audio-track]` = the Audio
   * section's flyout is open and, inside it, the audio-track flyout). A chain
   * (not a single id) is required because the model's tree is three levels deep
   * (`full > audio > audio-track > tracks`), and every level must stay visible
   * while its child is. Opening an item REPLACES the chain from that item's own
   * depth, which closes its sibling at the same level — the native menu's rule.
   */
  const [openChain, setOpenChain] = useState<readonly string[]>([]);
  const [openSides, setOpenSides] = useState<Readonly<Record<string, boolean>>>(
    {},
  );
  const lastOpenId: string | null = openChain[openChain.length - 1] ?? null;

  const closeSubmenu = () => {
    setOpenChain([]);
    setOpenSides({});
  };
  const { closeMenu } = useMoreMenuEvents({
    isMenuOpen: isOpen,
    setIsOpen: onClose,
    menuRef: triggerRef,
    dropdownRef: menuRef,
    setShowPlaylistsSubmenu: closeSubmenu,
    // Focus return is owned by useVideoMenu (it holds the trigger element).
    restoreFocus: false,
  });

  // Closing the menu must collapse every flyout. React's documented "adjust
  // state while rendering" pattern (the same one useMenuPlaylists uses) instead
  // of an effect, so reopening can never show a stale submenu and no cascading
  // render is introduced.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (!isOpen && openChain.length > 0) {
      setOpenChain([]);
      setOpenSides({});
    }
  }

  // APG: focus the first item whenever the menu opens, from either entry point.
  // The rows arrive one tick after the panel (the snapshot is async), so this
  // runs on `entries` too, not only on the open transition.
  useEffect(() => {
    if (!isOpen) return;
    focusMenuItemAt(menuRef.current, 0);
  }, [isOpen, entries]);

  if (!isOpen) return null;

  const openUpwards = buttonRect !== null && shouldOpenUpwards(buttonRect);

  // Both item roles (a checkable row is menuitemcheckbox), matched by the id
  // the model gave the entry.
  const entryEl = (id: string): HTMLElement | null | undefined =>
    menuRef.current?.querySelector<HTMLElement>(
      `[data-menu-id="${CSS.escape(id)}"]`,
    );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
    // Measure now (an event handler, the only place a ref may be read) and keep
    // the side per entry: a flyout that would spill past the right edge opens
    // leftwards instead.
    const rect = entryEl(id)?.getBoundingClientRect();
    setOpenSides((current) => ({
      ...current,
      [id]:
        rect !== undefined && rect.right + SUBMENU_WIDTH_PX > window.innerWidth,
    }));
    setOpenChain((current) =>
      current[chain.length] === id
        ? current.slice(0, chain.length)
        : [...chain, id],
    );
  };

  const renderItems = (list: NativeMenuEntry[], chain: readonly string[]) =>
    list.map((entry, index) => {
      if (entry.kind === "separator") {
        return (
          <div
            key={`separator-${String(index)}`}
            role="separator"
            className={SEPARATOR_CLASS}
          />
        );
      }
      return renderItem(entry, index, chain);
    });

  const renderItem = (
    entry: NativeMenuItem,
    index: number,
    chain: readonly string[],
  ) => {
    const depth = chain.length;
    const key = `item-${entry.id}-${String(index)}`;
    const disabled = entry.enabled === false;
    const hasChildren = (entry.children?.length ?? 0) > 0;

    // A checked row shows the checkmark in the leading slot — the native
    // menu's check column, and the only visual cue a DrPlay row has for it.
    const Icon = entry.checked === true ? Check : iconForEntry(entry.id);

    if (!hasChildren) {
      return (
        <div key={key} className="relative">
          <MoreMenuItem
            icon={Icon}
            label={entry.label}
            menuId={entry.id}
            checked={entry.checked}
            title={entry.shortcut}
            disabled={disabled}
            className={MENU_ITEM_BASE_CLASS}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(entry.id);
            }}
          />
        </div>
      );
    }

    const expanded = openChain[depth] === entry.id;
    // Which side this flyout opens on, measured when it was opened (a click or
    // ArrowRight) — the same decision, and the same timing, as
    // useMenuPlaylists' Add-to-Playlist submenu.
    const openLeft = openSides[entry.id] ?? false;

    return (
      <div key={key} className="relative">
        <MoreMenuItem
          icon={Icon}
          label={entry.label}
          menuId={entry.id}
          checked={entry.checked}
          depth={depth}
          expanded={expanded}
          title={entry.shortcut}
          disabled={disabled}
          className={`${MENU_ITEM_BASE_CLASS} justify-between`}
          trailing={
            <ChevronRight className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
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
            className={`${PANEL_CLASS} absolute bottom-0 ${
              openLeft ? "right-full mr-3" : "left-full ml-3"
            }`}
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
      className={PANEL_CLASS}
      style={getContextMenuStyle({ anchorPoint, buttonRect, openUpwards })}
      onClick={(e) => {
        e.stopPropagation();
      }}
      onKeyDown={handleKeyDown}
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
