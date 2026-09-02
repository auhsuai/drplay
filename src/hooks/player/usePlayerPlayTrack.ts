import { useCallback } from "react";
import type { useTranslation } from "react-i18next";
import type { Track } from "../../types";
import { recordPlay } from "../../utils/history";
import { getTrackMetadata } from "../../utils/metadata";
import { getValidToken } from "../../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../../utils/streamPrefetcher";
import { prefetchNextTrackAudio } from "../../utils/nextTrackPrefetcher";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import type { QueueDriveItem } from "./usePlayerQueue";
import type { TabKey } from "../../utils/driveConstants";
import { usePlayerStore } from "../../store/playerStore";
import { nativeAudioEngine } from "../../lib/nativeAudioBridge";
import { IS_MOBILE } from "../../utils/platform";
import { isAbortError } from "./utils";

// Fire-and-forget: prefetch the next track's audio for gapless playback.
function scheduleNextTrackPrefetch(
  queue: Track[] | undefined,
  current: Track,
): void {
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
}

export function usePlayerPlayTrack(
  accessToken: string | null,
  t: ReturnType<typeof useTranslation>["t"],
  userActedRef: { current: boolean },
  abortControllerRef: { current: AbortController | null },
  updateQueueContext: (
    track: Track,
    contextQueue?: Track[],
    driveItems?: ReadonlyArray<QueueDriveItem>,
    activeTab?: TabKey,
  ) => Track,
  setCurrentTrack: ReturnType<
    typeof usePlayerStore.getState
  >["setCurrentTrack"],
  setIsPlaying: ReturnType<typeof usePlayerStore.getState>["setIsPlaying"],
  setIsDownloading: ReturnType<
    typeof usePlayerStore.getState
  >["setIsDownloading"],
  triggerReload: ReturnType<typeof usePlayerStore.getState>["triggerReload"],
) {
  const createAbortSignal = useCallback((): AbortSignal => {
    abortControllerRef.current?.abort();
    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;
    return ctrl.signal;
  }, [abortControllerRef]);

  const handlePlayTrack = useCallback(
    async (
      track: Track,
      contextQueue?: Track[],
      isNavigation: boolean = false,
      driveItems?: ReadonlyArray<QueueDriveItem>,
      activeTab?: TabKey,
    ) => {
      if (!accessToken) return;
      userActedRef.current = true;

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

        if (signal.aborted) return;

        if (IS_MOBILE) {
          // GATE branch B: the /drive-stream SW proxy is dead on Android —
          // the native engine builds the Drive URL and sends the Authorization
          // header itself. Playback is still driven by the PlayerBar effect
          // (setCurrentTrack + triggerReload + isPlaying -> engine.playTrack),
          // exactly like the desktop path below — only the URL/token plumbing
          // differs. No metadata fetch, no next-track audio prefetch.
          nativeAudioEngine.setToken(freshToken);
          setCurrentTrack(targetTrack);
          triggerReload();
          setIsPlaying(true);
          setIsDownloading(false);
        } else {
          const streamUrl =
            prefetchedUrl ||
            buildStreamUrl(targetTrack.id, targetTrack.originalName);
          setCurrentTrack({ ...targetTrack, streamUrl });
          triggerReload();
          setIsPlaying(true);
          setIsDownloading(false);

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
        }

        void recordPlay(targetTrack).catch((e: unknown) => {
          void captureError({
            level: "warn",
            source: "usePlayer",
            message: `recordPlay-fail: ${e instanceof Error ? e.message : String(e)}`,
          });
        });
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
            "An unexpected error occurred. Check the error log in Settings.",
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
      createAbortSignal,
      userActedRef,
    ],
  );

  return { handlePlayTrack };
}
