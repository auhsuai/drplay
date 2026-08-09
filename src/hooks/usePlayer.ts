import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { set as idbSet } from "../db/kv";
import {
  start as keepAwakeStart,
  stop as keepAwakeStop,
} from "tauri-plugin-keepawake-api";
import type { Track } from "../types";
import { recordPlay } from "../utils/history";
import { getTrackMetadata } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../utils/streamPrefetcher";
import { prefetchNextTrackAudio } from "../utils/nextTrackPrefetcher";
import { showErrorToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../utils/sessionCleanup";
import { isAbortError } from "./player/utils";
import { usePlayerSession } from "./player/usePlayerSession";
import { usePlayerQueue } from "./player/usePlayerQueue";
import type { QueueDriveItem } from "./player/usePlayerQueue";
import type { TabKey } from "../utils/driveConstants";

import { usePlayerStore } from "../store/playerStore";
import { AudioController } from "../lib/AudioController";
import { useMediaSession } from "./useMediaSession";

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

  // Keep system awake
  useEffect(() => {
    if (isPlaying) {
      keepAwakeStart({ display: false, idle: false, sleep: true }).catch(
        (e: unknown) => {
          void captureError({
            level: "warn",
            source: "usePlayer",
            message: `keep-awake-failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        },
      );
    } else {
      keepAwakeStop().catch((e: unknown) => {
        void captureError({
          level: "warn",
          source: "usePlayer",
          message: `keep-awake-release-failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
    }
  }, [isPlaying]);

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
      // B3: release the real audio elements (buffers, src, pending retry)
      // before clearing the store state.
      AudioController.getInstance().release();
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

  const createAbortSignal = (): AbortSignal => {
    abortControllerRef.current?.abort();
    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;
    return ctrl.signal;
  };

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  const handlePlayTrack = useCallback(
    async (
      track: Track,
      contextQueue?: Track[],
      isNavigation: boolean = false,
      driveItems?: ReadonlyArray<QueueDriveItem>,
      activeTab?: TabKey,
    ) => {
      if (!accessToken) return;

      const { currentTrack } = usePlayerStore.getState();

      if (currentTrack?.id === track.id && !isNavigation) {
        if (!usePlayerStore.getState().isPlaying)
          usePlayerStore.getState().setIsPlaying(true);
        return;
      }

      let targetTrack = track;
      if (!isNavigation) {
        targetTrack = updateQueueContext(
          track,
          contextQueue,
          driveItems,
          activeTab,
        );
      }

      const signal = createAbortSignal();

      setIsPlaying(false);
      setIsDownloading(true);

      // Fire-and-forget: prefetch the next track's audio for gapless playback.
      const scheduleNextTrackPrefetch = (
        queue: Track[] | undefined,
        current: Track,
      ): void => {
        if (!queue || queue.length < 2) return;
        const idx = queue.findIndex((item) =>
          item.queueItemId
            ? item.queueItemId === current.queueItemId
            : item.id === current.id,
        );
        if (idx === -1 || idx >= queue.length - 1) return;
        const next = queue[idx + 1];
        if (next === undefined) return;
        const url =
          getPrefetchedStreamUrl(next.id) ??
          buildStreamUrl(next.id, next.originalName);
        if (url) prefetchNextTrackAudio(url);
      };

      const prefetchedUrl = getPrefetchedStreamUrl(targetTrack.id);

      try {
        const freshToken = await getValidToken(false, signal).catch(
          (e: unknown) => {
            if (isAbortError(e)) throw e;
            void captureError({
              level: "warn",
              source: "usePlayer",
              message: `token-refresh-fail: ${e instanceof Error ? e.message : String(e)}`,
            });
            return null;
          },
        );

        if (!freshToken) {
          setIsDownloading(false);
          return;
        }

        const streamUrl =
          prefetchedUrl ||
          buildStreamUrl(targetTrack.id, targetTrack.originalName);
        setCurrentTrack({ ...targetTrack, streamUrl });
        triggerReload();
        setIsPlaying(true);
        setIsDownloading(false);

        recordPlay(targetTrack).catch((e: unknown) => {
          void captureError({
            level: "warn",
            source: "usePlayer",
            message: `recordPlay-fail: ${e instanceof Error ? e.message : String(e)}`,
          });
        });

        scheduleNextTrackPrefetch(contextQueue, targetTrack);

        void (async () => {
          try {
            const metadata = await getTrackMetadata(
              targetTrack.id,
              freshToken,
              targetTrack.size,
              targetTrack.originalName,
              signal,
            );
            if (metadata.duration && !signal.aborted) {
              setCurrentTrack((prev) =>
                prev ? { ...prev, restoreDuration: metadata.duration } : prev,
              );
            }
          } catch (e: unknown) {
            if (!isAbortError(e)) {
              void captureError({
                level: "warn",
                source: "usePlayer",
                message: `metadata-prefetch-fail: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }
        })();
      } catch (e: unknown) {
        if (isAbortError(e)) return;
        void captureError({
          level: "error",
          source: "usePlayer",
          message: `network-playback-error: ${e instanceof Error ? e.message : String(e)}`,
        });
        showErrorToast(
          t(
            "player.exception_toast",
            "An exception occurred! Open Developer Tools (Ctrl+Shift+I) for details.",
          ),
        );
      } finally {
        if (!signal.aborted) {
          setIsDownloading(false);
        }
      }
    },
    [
      accessToken,
      triggerReload,
      updateQueueContext,
      setIsPlaying,
      setIsDownloading,
      setCurrentTrack,
      t,
    ],
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
          if (!freshToken) {
            setIsDownloading(false);
            return;
          }
          try {
            await getTrackMetadata(
              currentTrack.id,
              freshToken,
              currentTrack.size,
              currentTrack.originalName,
              signal,
            );
          } catch (e: unknown) {
            if (!isAbortError(e)) {
              void captureError({
                level: "warn",
                source: "usePlayer",
                message: `bitrate-resume-fail: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
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
          void captureError({
            level: "error",
            source: "usePlayer",
            message: `stream-url-resume-fail: ${e instanceof Error ? e.message : String(e)}`,
          });
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
  };
};
