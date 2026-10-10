import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../lib/mpvProtocol";
import { showErrorToast } from "../utils/simpleToast";
import type { NativeMenuEntry } from "../lib/nativeMenu";
import type { PlayerCommandContext } from "./commands";
import {
  buildContextMenuModel,
  runMenuEntry,
  takeVideoMenuSnapshot,
  type MenuSection,
  type VideoMenuSnapshot,
} from "./menuModel";

/**
 * Slice 2: the video menu is REACT state, not a native Win32 popup.
 *
 * One hook owns the whole interaction for BOTH entry points — the video bar's
 * More button and right-click on the video area — so they can never drift:
 * snapshot -> `buildContextMenuModel` -> the DrPlay renderer -> `runMenuEntry`.
 * The section and the entries come from `menuModel`, which stays the single
 * source of truth; the anchor is the ONLY per-entry-point difference.
 *
 * Why the chrome suspension rides on `onMenuOpenChange` rather than a menu
 * promise: the menu is now mounted/unmounted by React, so its open state IS the
 * signal. `useFullscreenChrome.setMenuOpen` (App) already reveals on open and
 * restarts a FRESH countdown on close — this hook only reports the transitions,
 * so Slice 1's timer policy is untouched.
 */

export type VideoMenuAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "button"; rect: DOMRect; trigger: HTMLElement | null };

export interface UseVideoMenuParams {
  ctx: PlayerCommandContext;
  isFullscreen: boolean;
  /** Slice 1's suspension seam: App forwards this to useFullscreenChrome. */
  onMenuOpenChange: (open: boolean) => void;
}

export interface VideoMenu {
  isOpen: boolean;
  /** Entries to render; empty until the open-time snapshot resolves. */
  entries: NativeMenuEntry[];
  anchorPoint: { x: number; y: number } | null;
  buttonRect: DOMRect | null;
  /** The trigger element, so focus can return to it on close (APG). */
  trigger: HTMLElement | null;
  open: (section: MenuSection, anchor: VideoMenuAnchor) => void;
  close: () => void;
  select: (id: string) => void;
}

export function useVideoMenu({
  ctx,
  isFullscreen,
  onMenuOpenChange,
}: UseVideoMenuParams): VideoMenu {
  const [isOpen, setIsOpen] = useState(false);
  const [entries, setEntries] = useState<NativeMenuEntry[]>([]);
  const [anchorPoint, setAnchorPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);

  // Refs for the values stable callbacks must read: `open`/`close`/`select`
  // are handed to React event props and to the memoized bar, so their identity
  // must never change.
  const contextRef = useRef(ctx);
  const fullscreenRef = useRef(isFullscreen);
  const openChangeRef = useRef(onMenuOpenChange);
  const snapshotRef = useRef<VideoMenuSnapshot | null>(null);
  /** Which anchor opened the CURRENT menu (drives the More-button toggle). */
  const openAnchorRef = useRef<VideoMenuAnchor["kind"] | null>(null);
  /** Monotonic token: a close (or another open) that lands mid-snapshot wins. */
  const openTokenRef = useRef(0);

  useEffect(() => {
    contextRef.current = ctx;
    fullscreenRef.current = isFullscreen;
    openChangeRef.current = onMenuOpenChange;
  });

  const close = useCallback(() => {
    openTokenRef.current += 1;
    openAnchorRef.current = null;
    snapshotRef.current = null;
    setEntries([]);
    setAnchorPoint(null);
    setButtonRect(null);
    setTrigger(null);
    setIsOpen((wasOpen) => {
      if (wasOpen) openChangeRef.current(false);
      return false;
    });
  }, []);

  const open = useCallback(
    (section: MenuSection, anchor: VideoMenuAnchor) => {
      // APG menu button: activating the trigger of an open menu closes it.
      if (openAnchorRef.current === "button" && anchor.kind === "button") {
        close();
        return;
      }
      const token = ++openTokenRef.current;
      openAnchorRef.current = anchor.kind;
      snapshotRef.current = null;
      setAnchorPoint(
        anchor.kind === "point" ? { x: anchor.x, y: anchor.y } : null,
      );
      setButtonRect(anchor.kind === "button" ? anchor.rect : null);
      setTrigger(anchor.kind === "button" ? anchor.trigger : null);
      setEntries([]);
      setIsOpen(true);
      // Opening IS player activity and it suspends the auto-hide, so the bar
      // can never vanish out from under an open menu (Slice 1's policy).
      openChangeRef.current(true);

      void (async () => {
        try {
          const snapshot = await takeVideoMenuSnapshot(fullscreenRef.current);
          if (openTokenRef.current !== token) return;
          snapshotRef.current = snapshot;
          setEntries(buildContextMenuModel(section, snapshot));
        } catch (e: unknown) {
          if (openTokenRef.current !== token) return;
          showErrorToast(describeError(e));
          close();
        }
      })();
    },
    [close],
  );

  const select = useCallback(
    (id: string) => {
      const snapshot = snapshotRef.current;
      if (snapshot === null) return;
      const context = contextRef.current;
      // Close FIRST: the menu must not wait on an async mpv call, and the close
      // restarts the chrome countdown immediately.
      close();
      void runMenuEntry(id, context, snapshot).catch((e: unknown) => {
        showErrorToast(describeError(e));
      });
    },
    [close],
  );

  // Focus return (APG), owned here because the trigger element lives in the
  // video bar: only the button path has one, and only when focus would
  // otherwise land on the body. The right-click path keeps focus where the
  // gesture left it.
  const closedTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (isOpen) {
      closedTriggerRef.current = trigger;
      return;
    }
    const previous = closedTriggerRef.current;
    closedTriggerRef.current = null;
    if (previous === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    previous.focus();
  }, [isOpen, trigger]);

  return {
    isOpen,
    entries,
    anchorPoint,
    buttonRect,
    trigger,
    open,
    close,
    select,
  };
}
