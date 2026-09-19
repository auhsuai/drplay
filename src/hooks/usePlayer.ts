import { useEffect, useRef, useCallback, useState } from "react";
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
import { commitIsPlaying } from "../store/playbackCommit";
import { useMediaControls } from "./useMediaControls";
import { resetAdvanceGuard } from "../utils/playerError";

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

  // F7-1: playMode persist must wait until the session restore finished
  // reading drplay_playmode, or the mount-time default write clobbers it.
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const handleSessionHydrated = useCallback(() => {
    setSessionHydrated(true);
  }, []);

  // Load session from IDB
  usePlayerSession(
    setCurrentTrack,
    setOriginalQueue,
    setPlaybackQueue,
    setPlayMode,
    triggerReload,
    handleSessionHydrated,
  );

  const handlePlayTrackRef = useRef<typeof handlePlayTrack>(undefined);
  // R5b: marker for the in-flight resume attempt owned by handleTogglePlay.
  // Set while its token fetch is pending, cleared when it settles — the
  // else-branch pause uses it to abort exactly that attempt (never a
  // play-attempt owned by handlePlayTrack).
  const resumeSignalRef = useRef<AbortSignal | null>(null);
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
    hydrated: sessionHydrated,
    setCurrentTrack,
    setIsPlaying,
    setOriginalQueue,
    setPlaybackQueue,
    resetBrokenTracks,
  });

  const {
    handlePlayTrack,
    createAbortSignal,
    isCurrentAttempt,
    abortCurrentAttempt,
  } = usePlayerTrackPlayback(accessToken, { updateQueueContext });

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
          commitIsPlaying("intent", true);
          return;
        }

        setIsDownloading(true);
        resumeSignalRef.current = signal;
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
          commitIsPlaying("intent", true);
        } catch (e: unknown) {
          if (isAbortError(e)) return;
          void logUsePlayer("error", `stream-url-resume-fail: ${errMsg(e)}`);
          showErrorToast(t("player.playback_failed"));
        } finally {
          if (resumeSignalRef.current === signal)
            resumeSignalRef.current = null;
          // Owner-check, not `!signal.aborted`: a user-pause abort keeps this
          // attempt as the ref's owner (abortCurrentAttempt does not swap it),
          // so the spinner it set must still be cleared; a superseded attempt
          // skips this and leaves the newer attempt's spinner alone.
          if (isCurrentAttempt(signal)) setIsDownloading(false);
        }
      } else {
        const { isPlaying: currentIsPlaying } = usePlayerStore.getState();
        // R5b: a pause (store is playing) while a resume attempt is still
        // awaiting its token must cancel that attempt first — otherwise the
        // late token commits URL + setIsPlaying(true) and overrides the
        // user's pause. Play-intent toggles leave the attempt running.
        if (currentIsPlaying) {
          const resumeSignal = resumeSignalRef.current;
          if (resumeSignal && isCurrentAttempt(resumeSignal)) {
            abortCurrentAttempt();
          }
        }
        commitIsPlaying("intent", !currentIsPlaying);
      }
    }
  }, [
    currentTrack,
    triggerReload,
    setIsDownloading,
    setCurrentTrack,
    isPlaying,
    createAbortSignal,
    isCurrentAttempt,
    abortCurrentAttempt,
    t,
  ]);

  // Bridge the OS media surface (Windows flyout / keyboard media keys) to the
  // existing player handlers. The native SMTC session lives in Rust
  // (src-tauri/src/media_controls.rs) — this hook only routes its events and
  // pushes state snapshots, so queue/playback logic stays single-sourced here.
  // F7-7 parity: media keys are manual transport entry points, same as the
  // PlayerBar buttons/keyboard — they must reset the storm guard before
  // delegating. Auto-advance calls handleNextTrack directly (never through
  // here), so it stays guarded. Do NOT move the reset into the raw handlers.
  useMediaControls({
    onTogglePlay: () => {
      resetAdvanceGuard();
      void handleTogglePlay();
    },
    onNext: () => {
      resetAdvanceGuard();
      handleNextTrack();
    },
    onPrev: () => {
      resetAdvanceGuard();
      handlePrevTrack();
    },
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
