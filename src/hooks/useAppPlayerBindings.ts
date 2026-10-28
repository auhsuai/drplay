import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { Track, TabKey } from "../types";
import type { QueueDriveItem } from "./player/usePlayerQueue";

/** `usePlayer().handlePlayTrack` — the raw (not the stable wrapper) handler. */
export type PlayerPlayTrack = (
  track: Track,
  contextQueue?: Track[],
  isNavigation?: boolean,
  driveItems?: ReadonlyArray<QueueDriveItem>,
  activeTab?: TabKey,
) => Promise<void>;

export interface AppPlayerBindingsDeps {
  /** `usePlayer().handleTogglePlay` — async; the wrapper drops the promise. */
  handleTogglePlay: () => Promise<void>;
  /** `usePlayer().handleNextTrack`. */
  handleNextTrack: () => void;
  /** `usePlayer().handlePrevTrack`. */
  handlePrevTrack: () => void;
  /** `usePlayer().handleTogglePlayMode`. */
  handleTogglePlayMode: () => void;
  /** `usePlayer().handlePlayTrack` — read through a ref by the stable wrappers. */
  playerPlayTrack: PlayerPlayTrack;
  /** App-owned selected tab; read through a ref by `stableHandleSelectTrack`. */
  activeTab: TabKey;
  /** App owns the overlay state (UI needs it); the hook only writes it. */
  setIsNowPlayingOpen: Dispatch<SetStateAction<boolean>>;
  /** App owns the fullscreen state (UI needs it); the hook only writes it. */
  setIsPlayerFullscreen: Dispatch<SetStateAction<boolean>>;
  /** App owns the queue drawer state (docked in AppShell); the hook writes it. */
  setIsQueueOpen: Dispatch<SetStateAction<boolean>>;
}

export interface AppPlayerBindings {
  stableHandleTogglePlay: () => void;
  stableHandleNextTrack: () => void;
  stableHandlePrevTrack: () => void;
  stableHandleTogglePlayMode: () => void;
  stableHandleSelectTrack: (track: Track) => void;
  onExpandNowPlaying: () => void;
  stableHandleCloseNowPlaying: () => void;
  stableHandleToggleFullscreen: () => void;
  stableHandleExitFullscreen: () => void;
  stableHandleToggleQueue: () => void;
  stableHandleCloseQueue: () => void;
  handlePlayTrack: (
    track: Track,
    contextQueue?: Track[],
    isNavigation?: boolean,
  ) => void;
}

/**
 * The bridge layer between App and the player/queue/menu surfaces: the five
 * ref-delegate wrappers PlayerBar and the player command context consume, the
 * Now Playing overlay/fullscreen transitions, the queue drawer toggles and the
 * tab-aware `handlePlayTrack`.
 *
 * Extracted verbatim from App.tsx (refactor only — every comment, call
 * signature and update order is unchanged). App keeps owning the three UI
 * state values and passes the setters in; `usePlayerCommands`, `useVideoMenu`
 * and `useFullscreenChrome` stay where they are — App just connects them.
 */
export function useAppPlayerBindings(
  deps: AppPlayerBindingsDeps,
): AppPlayerBindings {
  const {
    handleTogglePlay,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlayMode,
    playerPlayTrack,
    activeTab,
    setIsNowPlayingOpen,
    setIsPlayerFullscreen,
    setIsQueueOpen,
  } = deps;

  // F1 fix — TRUE ref-delegate wrappers (pattern: usePlayer.ts
  // stableHandlePlayTrack/handlePlayTrackRef). The PlayerBar memo comparator
  // intentionally ignores handler props (it compares only currentTrack.id /
  // isPlaying / playMode / isDownloading / loadNonce), so a plain useCallback
  // here changes identity WITHOUT ever reaching the memoized child when only
  // the playback queue mutates: the bar keeps firing a closure over the OLD
  // queue (plays deleted tracks / skips newly added ones). The wrapper below
  // keeps a STABLE identity across every render while delegating to the
  // freshest handler through the ref (re-assigned after each commit), so the
  // comparator's shortcut can no longer pin stale queue logic into the bar.
  const handleTogglePlayRef = useRef<typeof handleTogglePlay>(undefined);
  const stableHandleTogglePlay = useCallback(() => {
    void handleTogglePlayRef.current?.();
  }, []);
  const handleNextTrackRef = useRef<typeof handleNextTrack>(undefined);
  const stableHandleNextTrack = useCallback(() => {
    handleNextTrackRef.current?.();
  }, []);
  const handlePrevTrackRef = useRef<typeof handlePrevTrack>(undefined);
  const stableHandlePrevTrack = useCallback(() => {
    handlePrevTrackRef.current?.();
  }, []);
  const handleTogglePlayModeRef =
    useRef<typeof handleTogglePlayMode>(undefined);
  const stableHandleTogglePlayMode = useCallback(() => {
    handleTogglePlayModeRef.current?.();
  }, []);
  // Track selection from the queue panel is navigation, not a queue rebuild —
  // same contract as clicking a song row (isNavigation=true). The handler and
  // activeTab are read through refs so the stable wrapper never closes over a
  // stale queue/tab while PlayerBar's memo comparator ignores handler props.
  const playerPlayTrackRef = useRef<typeof playerPlayTrack>(undefined);
  const activeTabRef = useRef(activeTab);
  const stableHandleSelectTrack = useCallback((track: Track) => {
    void playerPlayTrackRef.current?.(
      track,
      undefined,
      true,
      [],
      activeTabRef.current,
    );
  }, []);
  useEffect(() => {
    handleTogglePlayRef.current = handleTogglePlay;
    handleNextTrackRef.current = handleNextTrack;
    handlePrevTrackRef.current = handlePrevTrack;
    handleTogglePlayModeRef.current = handleTogglePlayMode;
    playerPlayTrackRef.current = playerPlayTrack;
    activeTabRef.current = activeTab;
  }, [
    handleTogglePlay,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlayMode,
    playerPlayTrack,
    activeTab,
  ]);

  const onExpandNowPlaying = useCallback(() => {
    // `f` collapses as well as expands, so it also leaves fullscreen — the
    // overlay closing must never leave the fullscreen flag latched.
    setIsNowPlayingOpen((prev) => {
      if (prev) setIsPlayerFullscreen(false);
      return !prev;
    });
  }, [setIsNowPlayingOpen, setIsPlayerFullscreen]);
  // Leaving the overlay always leaves fullscreen too: fullscreen is only
  // meaningful while the overlay is up, and keeping the flag would re-enter it
  // on the next open.
  const stableHandleCloseNowPlaying = useCallback(() => {
    setIsNowPlayingOpen(false);
    setIsPlayerFullscreen(false);
  }, [setIsNowPlayingOpen, setIsPlayerFullscreen]);
  // Entering fullscreen opens the overlay in the same commit, so there is no
  // frame where `isPlayerFullscreen` is true while the surface is hidden.
  const stableHandleToggleFullscreen = useCallback(() => {
    setIsNowPlayingOpen(true);
    setIsPlayerFullscreen((prev) => !prev);
  }, [setIsNowPlayingOpen, setIsPlayerFullscreen]);
  const stableHandleExitFullscreen = useCallback(() => {
    setIsPlayerFullscreen(false);
  }, [setIsPlayerFullscreen]);

  // Queue drawer state lives at App level: the pane is docked in AppShell's
  // content row, not inside the memoized PlayerBar. Both wrappers keep a
  // stable identity (empty-dep useCallback + functional update), so the bar
  // is driven purely by the isQueueOpen prop.
  const stableHandleToggleQueue = useCallback(() => {
    setIsQueueOpen((prev) => !prev);
  }, [setIsQueueOpen]);
  const stableHandleCloseQueue = useCallback(() => {
    setIsQueueOpen(false);
  }, [setIsQueueOpen]);

  const handlePlayTrack = (
    track: Track,
    contextQueue?: Track[],
    isNavigation: boolean = false,
  ) => {
    // Fire-and-forget: usePlayer's handlePlayTrack handles its own errors.
    void playerPlayTrack(track, contextQueue, isNavigation, [], activeTab);
  };

  return {
    stableHandleTogglePlay,
    stableHandleNextTrack,
    stableHandlePrevTrack,
    stableHandleTogglePlayMode,
    stableHandleSelectTrack,
    onExpandNowPlaying,
    stableHandleCloseNowPlaying,
    stableHandleToggleFullscreen,
    stableHandleExitFullscreen,
    stableHandleToggleQueue,
    stableHandleCloseQueue,
    handlePlayTrack,
  };
}
