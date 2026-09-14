import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Track } from "../types";
import { getValidToken } from "../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../utils/streamPrefetcher";
import { showErrorToast } from "../utils/simpleToast";
import { isAbortError } from "./player/utils";
import {
  usePlayerLifecycle,
  errMsg,
  logUsePlayer,
} from "./player/usePlayerLifecycle";
import { usePlayerTrackPlayback } from "./player/usePlayerTrackPlayback";
import { usePlayerSession } from "./player/usePlayerSession";
import { usePlayerQueue } from "./player/usePlayerQueue";
import type { QueueDriveItem } from "./player/usePlayerQueue";
import type { TabKey } from "../utils/driveConstants";

import { usePlayerStore } from "../store/playerStore";
import { useMediaSession } from "./useMediaSession";

export { PLAYER_STOP_EVENT } from "./player/usePlayerLifecycle";

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

  // Load session from IDB
  usePlayerSession(
    setCurrentTrack,
    setOriginalQueue,
    setPlaybackQueue,
    setPlayMode,
    triggerReload,
  );

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
    handleSetPlayMode,
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

  usePlayerLifecycle({
    isPlaying,
    playMode,
    setCurrentTrack,
    setIsPlaying,
    setOriginalQueue,
    setPlaybackQueue,
    resetBrokenTracks,
  });

  const { handlePlayTrack, createAbortSignal } = usePlayerTrackPlayback(
    accessToken,
    { updateQueueContext },
  );

  useEffect(() => {
    handlePlayTrackRef.current = handlePlayTrack;
  }, [handlePlayTrack]);

  const handleTogglePlay = useCallback(async () => {
    if (currentTrack) {
      if (!currentTrack.streamUrl && !isPlaying) {
        const signal = createAbortSignal();

        const prefetchedUrl = getPrefetchedStreamUrl(currentTrack.id);

        if (prefetchedUrl) {
          setCurrentTrack((prev) =>
            prev ? { ...prev, streamUrl: prefetchedUrl } : prev,
          );
          triggerReload();
          setIsPlaying(true);
          return;
        }

        setIsDownloading(true);
        try {
          const freshToken = await getValidToken(false, signal);

          // guard (UTP-1 parity): the LEAD token-refresh branch does not race
          // the signal, so an aborted attempt resumes here — never commit it.
          if (signal.aborted) return;

          if (!freshToken) {
            setIsDownloading(false);
            return;
          }

          const url = buildStreamUrl(
            currentTrack.id,
            currentTrack.originalName,
          );

          setCurrentTrack((prev) =>
            prev ? { ...prev, streamUrl: url } : prev,
          );
          triggerReload();
          setIsPlaying(true);
        } catch (e: unknown) {
          if (isAbortError(e)) return;
          void logUsePlayer("error", `stream-url-resume-fail: ${errMsg(e)}`);
          showErrorToast(t("player.playback_failed"));
        } finally {
          if (!signal.aborted) setIsDownloading(false);
        }
      } else {
        const { isPlaying: currentIsPlaying } = usePlayerStore.getState();
        setIsPlaying(!currentIsPlaying);
      }
    }
  }, [
    currentTrack,
    triggerReload,
    setIsDownloading,
    setCurrentTrack,
    setIsPlaying,
    isPlaying,
    createAbortSignal,
    t,
  ]);

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
    handleSetPlayMode,
  };
};
