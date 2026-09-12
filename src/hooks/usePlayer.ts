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
import { getTrackMetadata, metadataCache } from "../utils/metadata";
import { getValidToken } from "../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../utils/streamPrefetcher";
import { showErrorToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../utils/sessionCleanup";
import { prefetchTrackInServiceWorker } from "../utils/swPrefetch";
import { isAbortError } from "./player/utils";
import { usePlayerSession } from "./player/usePlayerSession";
import { usePlayerQueue } from "./player/usePlayerQueue";
import type { QueueDriveItem } from "./player/usePlayerQueue";
import type { TabKey } from "../utils/driveConstants";

import { usePlayerStore } from "../store/playerStore";
import { AudioController } from "../lib/AudioController";
import { useMediaSession } from "./useMediaSession";

export const PLAYER_STOP_EVENT = "player-stop";

// Why: fallback for the deferred metadata fetch — >> typical first-audio
// (<2s on a healthy network) so it never fires early on a normal play,
// << user patience and the ~30s Drive throttle/first-byte spike so
// duration/cover still arrive when the signal is missed (staged-preload
// pattern: display-only data loads only after playback is confirmed).
const METADATA_DEFER_FALLBACK_MS = 9_000;

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const logUsePlayer = (
  level: "warn" | "error",
  message: string,
): Promise<void> => captureError({ level, source: "usePlayer", message });

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
  // P1 pre-play gate: fileId of the most recently BLOCKED track. A second
  // consecutive click on the same id forces playback; any other user click
  // (different track or unflagged) resets it.
  const blockedStreamRef = useRef<string | undefined>(undefined);

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
          void logUsePlayer("warn", `keep-awake-failed: ${errMsg(e)}`);
        },
      );
    } else {
      keepAwakeStop().catch((e: unknown) => {
        void logUsePlayer("warn", `keep-awake-release-failed: ${errMsg(e)}`);
      });
    }
  }, [isPlaying]);

  // Persist playMode
  useEffect(() => {
    idbSet(SESSION_CLEANUP_KEYS.playModeKv, playMode).catch((e: unknown) => {
      void logUsePlayer("warn", `playmode-save-fail: ${errMsg(e)}`);
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

      // P1 pre-play gate — user-initiated clicks only (auto-advance enters
      // with isNavigation=true and must keep attempting flagged tracks: the
      // queue has no filter and its format_error guard still advances past a
      // failing file). The card metadata pipeline has normally already parsed
      // the entry into metadataCache by click time, so the flag read is
      // synchronous and a blocked click never delays or disturbs current
      // playback, any session state, or restoreDuration. First click on a
      // flagged track: toast + remember the id; an immediate second click on
      // the SAME id forces playback (user override — the browser may still
      // surface a real format error, which is their call).
      if (!isNavigation) {
        const cached = metadataCache.get(track.id);
        if (cached?.streamUnplayable === true) {
          if (blockedStreamRef.current === track.id) {
            blockedStreamRef.current = undefined;
          } else {
            blockedStreamRef.current = track.id;
            showErrorToast(
              t(
                "player.stream_unplayable",
                "This track can't be streamed (moov at file end). Press play again to try.",
              ),
            );
            return;
          }
        } else if (blockedStreamRef.current !== undefined) {
          blockedStreamRef.current = undefined;
        }
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

      // NOTE: no page-side prefetch fetch here. The old warm-up fetch was
      // dead weight: public/sw.js answers upstream Drive fetches with
      // `cache: 'no-store'`, so a page-side Range warm-up never lands in the
      // Chromium HTTP cache (and re-enabling that cache is not safe — see the
      // sw.js comment on Chromium bug #1026867 / PIPELINE_ERROR_READ).
      // Slice 2 instead asks the SW to warm its own IDB byte-cache for the
      // NEXT track in queue (the current one streams through the SW anyway
      // and write-through caches it as it plays).
      const nextTrack = playbackQueue.find(
        (t) => t.id !== targetTrack.id && t.id,
      );
      if (nextTrack) prefetchTrackInServiceWorker(nextTrack.id);

      const prefetchedUrl = getPrefetchedStreamUrl(targetTrack.id);

      try {
        const freshToken = await getValidToken(false, signal).catch(
          (e: unknown) => {
            if (isAbortError(e)) throw e;
            void logUsePlayer("warn", `token-refresh-fail: ${errMsg(e)}`);
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
          void logUsePlayer("warn", `recordPlay-fail: ${errMsg(e)}`);
        });

        // Why: FLAC metadata (1.5MB head + 64KB chunks + next-track
        // prefetch) races mpv's first bytes for Drive quota right when its
        // cache is empty — defer this display-only fetch until audio
        // provably flows (first-audio) or the fallback fires, so the stream
        // TTFB never competes with metadata. mpv decodes from its own
        // stream header; restoreDuration only feeds SeekBar text + session.
        let metadataSettled = false;
        let metadataTimer: ReturnType<typeof setTimeout> | undefined;
        const metadataAudio = AudioController.getInstance();
        let unsubFirstAudio: (() => void) | undefined;
        let unsubMetadataError: (() => void) | undefined;
        const cleanupMetadataDefer = (): void => {
          if (metadataTimer !== undefined) {
            clearTimeout(metadataTimer);
            metadataTimer = undefined;
          }
          unsubFirstAudio?.();
          unsubFirstAudio = undefined;
          unsubMetadataError?.();
          unsubMetadataError = undefined;
          signal.removeEventListener("abort", dropMetadataDefer);
        };
        const fireMetadataDefer = (): void => {
          if (metadataSettled || signal.aborted) return;
          metadataSettled = true;
          cleanupMetadataDefer();
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
                void logUsePlayer(
                  "warn",
                  `metadata-prefetch-fail: ${errMsg(e)}`,
                );
              }
            }
          })();
        };
        function dropMetadataDefer(): void {
          if (metadataSettled) return;
          metadataSettled = true;
          cleanupMetadataDefer();
        }
        unsubFirstAudio = metadataAudio.on("first-audio", fireMetadataDefer);
        // Why: a failed playback must not fetch display-only metadata for a
        // dead track — drop the pending fetch instead of wasting quota.
        unsubMetadataError = metadataAudio.on("error", dropMetadataDefer);
        // Why: track change (createAbortSignal aborts the previous signal)
        // and unmount (cleanup effect aborts) both land here — drop the
        // stale track's fetch and free its timer/listeners.
        signal.addEventListener("abort", dropMetadataDefer, { once: true });
        metadataTimer = setTimeout(
          fireMetadataDefer,
          METADATA_DEFER_FALLBACK_MS,
        );
      } catch (e: unknown) {
        if (isAbortError(e)) return;
        void logUsePlayer("error", `network-playback-error: ${errMsg(e)}`);
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
      playbackQueue,
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
              void logUsePlayer("warn", `bitrate-resume-fail: ${errMsg(e)}`);
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
