import { useCallback, useEffect, useRef } from "react";
import type { TabKey, Track } from "../types";
import { usePlayer } from "./usePlayer";

/**
 * App-level player wiring: usePlayer plus the F1 ref-delegate stable
 * wrappers, verbatim from App.tsx.
 *
 * F1 fix — TRUE ref-delegate wrappers (pattern: usePlayer.ts
 * stableHandlePlayTrack/handlePlayTrackRef). The PlayerBar memo comparator
 * intentionally ignores handler props (it compares only currentTrack.id /
 * isPlaying / playMode / isDownloading / loadNonce), so a plain useCallback
 * here changes identity WITHOUT ever reaching the memoized child when only
 * the playback queue mutates: the bar keeps firing a closure over the OLD
 * queue (plays deleted tracks / skips newly added ones). The wrapper below
 * keeps a STABLE identity across every render while delegating to the
 * freshest handler through the ref (re-assigned after each commit), so the
 * comparator's shortcut can no longer pin stale queue logic into the bar.
 */
export function useAppPlayer(accessToken: string | null, activeTab: TabKey) {
  const {
    currentTrack,
    isPlaying,
    isDownloading,
    playMode,
    handlePlayTrack: playerPlayTrack,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlay,
    handleTogglePlayMode,
    loadNonce,
  } = usePlayer(accessToken);

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
  useEffect(() => {
    handleTogglePlayRef.current = handleTogglePlay;
    handleNextTrackRef.current = handleNextTrack;
    handlePrevTrackRef.current = handlePrevTrack;
    handleTogglePlayModeRef.current = handleTogglePlayMode;
  }, [
    handleTogglePlay,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlayMode,
  ]);

  const handlePlayTrack = (
    track: Track,
    contextQueue?: Track[],
    isNavigation: boolean = false,
  ) => {
    // Fire-and-forget: usePlayer's handlePlayTrack handles its own errors.
    void playerPlayTrack(track, contextQueue, isNavigation, [], activeTab);
  };

  return {
    currentTrack,
    isPlaying,
    isDownloading,
    playMode,
    handlePlayTrack,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlay,
    handleTogglePlayMode,
    loadNonce,
    stableHandleTogglePlay,
    stableHandleNextTrack,
    stableHandlePrevTrack,
    stableHandleTogglePlayMode,
  };
}
