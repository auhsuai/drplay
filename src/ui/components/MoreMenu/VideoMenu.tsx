import { useEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
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
import { VIDEO_MENU_ITEM_CLASS } from "./constants";
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

/** Everything EXCEPT positioning — shared by the root panel and every flyout. */
const PANEL_BASE_CLASS =
  "z-[10000] w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 flex flex-col transition-all animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none";

/**
 * The root panel is placed by `getContextMenuStyle`'s inline left/top, so it is
 * viewport-positioned. The flyouts carry NO inline style and resolve
 * left-full/right-full against the `relative` row that wraps each parent — so
 * they must be `absolute`. The positioning utility therefore lives in a
 * SEPARATE constant on purpose: `fixed` and `absolute` have equal specificity,
 * so in one merged class whichever Tailwind emits later in the stylesheet wins
 * (measured: `.fixed` after `.absolute`), which silently turned every flyout
 * into a viewport-anchored panel and pushed it off-screen.
 */
const ROOT_PANEL_CLASS = `fixed ${PANEL_BASE_CLASS}`;

const SUBMENU_PANEL_CLASS = `absolute ${PANEL_BASE_CLASS}`;

/** Breathing room between a flyout and the viewport edge, in CSS px. */
const FLYOUT_VIEWPORT_MARGIN_PX = 8;

/** Gap between a parent row and its flyout. Mirrors the old `ml-3` / `mr-3`. */
const FLYOUT_GAP_PX = 12;

const SEPARATOR_CLASS =
  "my-1 h-px border-t border-gray-100 dark:border-gray-800/60";

/**
 * The queue can hold 50 rows. Boxing just that run keeps the flyout at roughly
 * five rows tall — the menu stays on screen instead of running off the top —
 * and every other track stays reachable by scrolling inside the box. Scrolling
 * it does NOT dismiss the menu: useMoreMenuEvents ignores a scroll whose target
 * is inside the panel.
 */
const QUEUE_SCROLL_CLASS = "max-h-[10.5rem] overflow-y-auto";

/**
 * Hide the glyph INVISIBLY rather than removing the icon slot: the row keeps its
 * 16px column, so labels stay aligned with the rows next to them. Applied via
 * MoreMenuItem's existing `iconClassName` prop — the shared item renderer is not
 * touched.
 */
const NO_GLYPH_ICON_CLASS = "w-4 h-4 opacity-0";

/**
 * The track being played, Playlist submenu only: DrPlay's brand blue instead of
 * the checkmark that used to sit in the (already blank) icon column.
 * `brand-text` is the project's theme-aware accent — #1967d2 on light, #8ab4f8
 * on dark, both AA on their surface (App.css owns the tokens).
 *
 * The `!` markers are deliberate, not laziness: the shared row class already
 * carries `hover:bg-gray-50 dark:hover:bg-[#33343a]` and `dark:text-gray-200`,
 * and two utilities of equal specificity are decided purely by which one
 * Tailwind emits last. Pinning the highlight makes "the playing track stays
 * blue, even under the pointer" a guarantee instead of a coin flip. Nothing
 * else on the row competes for background or text colour.
 */
const QUEUE_CURRENT_CLASS =
  "text-brand-text! bg-brand-primary/10! dark:bg-brand-primary/15! hover:bg-brand-primary/20!";

/** A queue row — the run that gets boxed into the scroll area, and the only
 *  place the check column is replaced by the brand highlight. */
function isQueueItem(entry: NativeMenuEntry): entry is NativeMenuItem {
  return entry.kind === "item" && entry.id.startsWith(MENU_PREFIXES.queue);
}

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

/**
 * True only on a pointer-driven device, so a tap/touch (or any hoverless input
 * method) keeps click-to-toggle instead of opening a flyout under a finger.
 * jsdom implements no `matchMedia` (verified on jsdom 29) — same fallback the
 * other responsive helpers here use.
 */
function hasHoverPointer(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

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
    }
  }

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
   * Place one flyout against its parent row, measured for real.
   *
   * Runs from the panel's ref callback, i.e. after the DOM node exists — which
   * is the only moment its HEIGHT is knowable. A pure-CSS `top-0` / `left-full`
   * cannot express "unless there is no room", which is exactly the whole
   * problem: a queue flyout opened from a row near the bottom of the screen
   * used to run off it.
   *
   * Rules:
   *  - vertically, the panel's top tracks the row's top whenever that fits;
   *    otherwise it slides up until its bottom clears the viewport edge. Each
   *    level clamps on its own — its height is its own.
   *  - horizontally the side is INHERITED from the first flyout (`depth === 0`
   *    decides, every deeper level follows). Deciding per level is what made a
   *    left-opening submenu's child flip back right and overlap the root.
   *
   * Idempotent: the same inputs always produce the same two properties, so the
   * ref callback re-firing on a re-render cannot make the panel jump. Nothing
   * re-measures while the pointer moves, so travelling between a row and its
   * flyout never shifts it.
   */
  const positionFlyout = (panel: HTMLDivElement, depth: number) => {
    const parent = panel.offsetParent;
    if (!(parent instanceof HTMLElement)) return;
    const row = parent.getBoundingClientRect();
    const margin = FLYOUT_VIEWPORT_MARGIN_PX;

    const highest = Math.max(
      margin,
      window.innerHeight - panel.offsetHeight - margin,
    );
    const desiredTop = Math.min(Math.max(row.top, margin), highest);
    panel.style.top = `${String(Math.round(desiredTop - row.top))}px`;

    const roomOnRight =
      row.right + FLYOUT_GAP_PX + panel.offsetWidth + margin <=
      window.innerWidth;
    const side =
      depth === 0
        ? roomOnRight
          ? "right"
          : "left"
        : (cascadeSideRef.current ?? (roomOnRight ? "right" : "left"));
    if (depth === 0) cascadeSideRef.current = side;

    const beside = `calc(100% + ${String(FLYOUT_GAP_PX)}px)`;
    panel.style.left = side === "right" ? beside : "auto";
    panel.style.right = side === "left" ? beside : "auto";
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
              if (panel !== null) positionFlyout(panel, depth);
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
