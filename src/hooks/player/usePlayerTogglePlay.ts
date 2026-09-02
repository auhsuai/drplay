import { useCallback } from "react";
import type { useTranslation } from "react-i18next";
import type { Track } from "../../types";
import { getTrackMetadata } from "../../utils/metadata";
import { getValidToken } from "../../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../../utils/streamPrefetcher";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { usePlayerStore } from "../../store/playerStore";
import { nativeAudioEngine } from "../../lib/nativeAudioBridge";
import { IS_MOBILE } from "../../utils/platform";
import { isAbortError } from "./utils";

export function usePlayerTogglePlay(
  t: ReturnType<typeof useTranslation>["t"],
  userActedRef: { current: boolean },
  abortControllerRef: { current: AbortController | null },
  currentTrack: Track | null,
  isPlaying: boolean,
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

  const handleTogglePlay = useCallback(async () => {
    if (currentTrack) {
      // Toggle với track hiện có là tương tác thật; toggle khi chưa có track
      // là no-op nên KHÔNG tính (restore vẫn phải chạy đủ).
      userActedRef.current = true;
      if (IS_MOBILE) {
        // GATE branch B: mobile tracks never carry a /drive-stream streamUrl —
        // resume means "re-arm the native engine with a fresh token" (the
        // PlayerBar effect then calls engine.playTrack, which restores
        // restoreTime). Pause stays a store flag flip (same effect drives
        // engine.pause).
        if (isPlaying) {
          setIsPlaying(false);
          return;
        }
        const signal = createAbortSignal();
        setIsDownloading(true);
        try {
          const freshToken = await getValidToken(false, signal);
          if (!freshToken) {
            setIsDownloading(false);
            return;
          }
          if (signal.aborted) return;
          nativeAudioEngine.setToken(freshToken);
          setCurrentTrack((prev) => (prev ? { ...prev } : prev));
          triggerReload();
          setIsPlaying(true);
        } catch (e: unknown) {
          if (isAbortError(e)) return;
          void captureError({
            level: "error",
            source: "usePlayer",
            message: `native-resume-fail: ${e instanceof Error ? e.message : String(e)}`,
          });
          showErrorToast(t("player.playback_failed"));
        } finally {
          if (!signal.aborted) setIsDownloading(false);
        }
        return;
      }
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

          if (signal.aborted) return;

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
    createAbortSignal,
    userActedRef,
  ]);

  return { handleTogglePlay };
}
