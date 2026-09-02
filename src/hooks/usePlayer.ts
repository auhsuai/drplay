import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { set as idbSet } from "../db/kv";
import type { Track } from "../types";
import { captureError } from "../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../utils/sessionCleanup";
import { usePlayerSession } from "./player/usePlayerSession";
import { usePlayerQueue } from "./player/usePlayerQueue";
import type { QueueDriveItem } from "./player/usePlayerQueue";
import { usePlayerPlayTrack } from "./player/usePlayerPlayTrack";
import { usePlayerTogglePlay } from "./player/usePlayerTogglePlay";
import type { TabKey } from "../utils/driveConstants";

import { usePlayerStore } from "../store/playerStore";
import { getPlaybackEngine } from "../lib/nativeAudioBridge";
import { useMediaSession } from "./useMediaSession";
import { useNativeAudio } from "./useNativeAudio";

export const PLAYER_STOP_EVENT = "player-stop";

export const usePlayer = (accessToken: string | null) => {
  const { t } = useTranslation();
  const {
    currentTrack,
    setCurrentTrack,
    loadNonce,
    triggerReload,
    isPlaying,
    setIsPlaying,
    isDownloading,
    setIsDownloading,
    playMode,
    setPlayMode,
    originalQueue,
    setOriginalQueue,
    playbackQueue,
    setPlaybackQueue,
    resetBrokenTracks,
  } = usePlayerStore(
    useShallow((state) => ({
      currentTrack: state.currentTrack,
      setCurrentTrack: state.setCurrentTrack,
      loadNonce: state.loadNonce,
      triggerReload: state.triggerReload,
      isPlaying: state.isPlaying,
      setIsPlaying: state.setIsPlaying,
      isDownloading: state.isDownloading,
      setIsDownloading: state.setIsDownloading,
      playMode: state.playMode,
      setPlayMode: state.setPlayMode,
      originalQueue: state.originalQueue,
      setOriginalQueue: state.setOriginalQueue,
      playbackQueue: state.playbackQueue,
      setPlaybackQueue: state.setPlaybackQueue,
      resetBrokenTracks: state.resetBrokenTracks,
    })),
  );

  const abortControllerRef = useRef<AbortController | null>(null);

  // user-wins guard for session restore: flipped true by real user actions
  // (play a track / toggle play with a track present) so a pending restore
  // stands down instead of overwriting the user's fresh state. Lives on this
  // hook's ref so it survives StrictMode double-mount; read through a stable
  // callback so usePlayerSession's effect never re-runs.
  const userActedRef = useRef(false);
  const hasUserInteracted = useCallback(() => userActedRef.current, []);

  // Load session from IDB
  usePlayerSession(
    setCurrentTrack,
    setOriginalQueue,
    setPlaybackQueue,
    setPlayMode,
    triggerReload,
    hasUserInteracted,
  );

  // GATE branch B: on Android the SW proxy is dead, so playback runs through
  // the native ExoPlayer engine — this hook only owns the plugin lifecycle
  // (initialize + notification permission). Desktop: inert.
  useNativeAudio();

  const handlePlayTrackRef = useRef<typeof handlePlayTrack>(undefined);
  const stableHandlePlayTrack = useCallback(
    (
      track: Track,
      contextQueue?: Track[],
      isNavigation?: boolean,
      driveItems?: ReadonlyArray<QueueDriveItem>,
      activeTab?: TabKey,
    ) => {
      void handlePlayTrackRef.current?.(
        track,
        contextQueue,
        isNavigation,
        driveItems,
        activeTab,
      );
    },
    [],
  );

  // Initialize queue handlers
  const {
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlayMode,
    updateQueueContext,
  } = usePlayerQueue(
    currentTrack,
    playbackQueue,
    originalQueue,
    playMode,
    setPlaybackQueue,
    setOriginalQueue,
    setPlayMode,
    stableHandlePlayTrack,
  );

  const { handlePlayTrack } = usePlayerPlayTrack(
    accessToken,
    t,
    userActedRef,
    abortControllerRef,
    updateQueueContext,
    setCurrentTrack,
    setIsPlaying,
    setIsDownloading,
    triggerReload,
  );
  useEffect(() => {
    handlePlayTrackRef.current = handlePlayTrack;
  }, [handlePlayTrack]);

  const { handleTogglePlay } = usePlayerTogglePlay(
    t,
    userActedRef,
    abortControllerRef,
    currentTrack,
    isPlaying,
    setCurrentTrack,
    setIsPlaying,
    setIsDownloading,
    triggerReload,
  );

  // Persist playMode
  useEffect(() => {
    idbSet(SESSION_CLEANUP_KEYS.playModeKv, playMode).catch((e: unknown) => {
      void captureError({
        level: "warn",
        source: "usePlayer",
        message: `playmode-save-fail: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
  }, [playMode]);

  // Cleanup on logout
  useEffect(() => {
    const handleStop = () => {
      // Abort any in-flight token/stream continuation first so a late
      // resolve cannot resurrect playback after logout (ghost playback).
      abortControllerRef.current?.abort();
      // B3: release the real audio elements (buffers, src, pending retry)
      // before clearing the store state. On mobile the native engine is
      // released instead (pause + token drop).
      void getPlaybackEngine().release();
      setCurrentTrack(null);
      setIsPlaying(false);
      setOriginalQueue([]);
      setPlaybackQueue([]);
      // Task D residual: forget broken-track marks so they don't leak
      // into the next session (auto-advance guard would skip a track that
      // may play fine after a fresh login).
      resetBrokenTracks();
    };
    window.addEventListener(PLAYER_STOP_EVENT, handleStop);
    return () => {
      window.removeEventListener(PLAYER_STOP_EVENT, handleStop);
    };
  }, [
    setCurrentTrack,
    setIsPlaying,
    setOriginalQueue,
    setPlaybackQueue,
    resetBrokenTracks,
  ]);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  // Bridge OS media keys / Windows flyout (Media Session API) to the existing
  // player handlers. Called unconditionally: with no track the session shows
  // "none" and the hook no-ops when navigator.mediaSession is unavailable.
  useMediaSession({
    onTogglePlay: () => {
      void handleTogglePlay();
    },
    onNext: handleNextTrack,
    onPrev: handlePrevTrack,
  });

  return {
    currentTrack,
    setCurrentTrack,
    loadNonce,
    triggerReload,
    isPlaying,
    setIsPlaying,
    isDownloading,
    playbackQueue,
    playMode,
    handlePlayTrack,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlay,
    handleTogglePlayMode,
  };
};
