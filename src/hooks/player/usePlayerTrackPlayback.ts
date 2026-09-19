import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Track } from "../../types";
import { recordPlay } from "../../utils/history";
import { getTrackMetadata, metadataCache } from "../../utils/metadata";
import { getValidToken } from "../../utils/apiClient";
import {
  getPrefetchedStreamUrl,
  buildStreamUrl,
} from "../../utils/streamPrefetcher";
import { showErrorToast } from "../../utils/simpleToast";
import { prefetchTrackInServiceWorker } from "../../utils/swPrefetch";
import { isAbortError, resolveNextTrack } from "./utils";
import { onceAfterFirstAudio } from "./deferOnce";
import { errMsg, logUsePlayer, PLAYER_STOP_EVENT } from "./usePlayerLifecycle";
import type { QueueDriveItem } from "./usePlayerQueue";
import type { TabKey } from "../../utils/driveConstants";
import { usePlayerStore } from "../../store/playerStore";
import { commitIsPlaying } from "../../store/playbackCommit";
import { AudioController } from "../../lib/AudioController";
import {
  abortCurrentIntent,
  beginIntent,
  commitIfCurrent,
  getCurrentIntentSignal,
  type IntentHandle,
} from "./playbackIntent";

// Why: fallback for the deferred metadata fetch — >> typical first-audio
// (<2s on a healthy network) so it never fires early on a normal play,
// << user patience and the ~30s Drive throttle/first-byte spike so
// duration/cover still arrive when the signal is missed (staged-preload
// pattern: display-only data loads only after playback is confirmed).
const METADATA_DEFER_FALLBACK_MS = 9_000;

export interface TrackPlaybackDeps {
  updateQueueContext: (
    track: Track,
    contextQueue?: Track[],
    driveItems?: ReadonlyArray<QueueDriveItem>,
    activeTab?: TabKey,
  ) => Track;
}

export function usePlayerTrackPlayback(
  accessToken: string | null,
  { updateQueueContext }: TrackPlaybackDeps,
) {
  const { t } = useTranslation();
  const { triggerReload, setIsDownloading, setCurrentTrack } = usePlayerStore(
    useShallow((state) => ({
      triggerReload: state.triggerReload,
      setIsDownloading: state.setIsDownloading,
      setCurrentTrack: state.setCurrentTrack,
    })),
  );

  // R3.1a: the play attempt's identity/abort lifecycle lives in the playback
  // intent controller now (supersede, epoch, abort). This ref only lets the
  // hook retire the attempt IT still owns on unmount — end() is a no-op for a
  // handle a newer intent already superseded.
  const intentRef = useRef<IntentHandle | null>(null);
  // P1 pre-play gate: fileId of the most recently BLOCKED track. A second
  // consecutive click on the same id forces playback; any other user click
  // (different track or unflagged) resets it.
  const blockedStreamRef = useRef<string | undefined>(undefined);

  const beginPlayIntent = (): IntentHandle => {
    const intent = beginIntent("play");
    intentRef.current = intent;
    return intent;
  };

  // Why: the controller grants a new play intent by superseding the previous
  // one (same swap the old AbortController ref did), so callers get the fresh
  // signal directly. Kept as the hook's public entry for attempt-supersede
  // tests and any resume-style caller that only needs the signal.
  const createAbortSignal = (): AbortSignal => beginPlayIntent().abortSignal;

  // Why: isDownloading is shared by every attempt; a superseded attempt must
  // only clear the spinner it still owns (same signal as the current intent) —
  // a later attempt has already set its own state on the same flag.
  const isCurrentAttempt = (signal: AbortSignal): boolean =>
    getCurrentIntentSignal() === signal;

  useEffect(() => {
    const handleStop = () => {
      abortCurrentIntent();
    };
    window.addEventListener(PLAYER_STOP_EVENT, handleStop);
    return () => {
      window.removeEventListener(PLAYER_STOP_EVENT, handleStop);
      abortCurrentIntent();
      // Retire the attempt this hook still owns: a pending token await must
      // not leave a module-global user intent guarding system lanes after the
      // hook is gone (its commit is already blocked by the abort).
      intentRef.current?.end();
      // The spinner's owner is gone; a later attempt will set its own state.
      setIsDownloading(false);
    };
  }, [setIsDownloading]);

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
          commitIsPlaying("intent", true);
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

      const intent = beginPlayIntent();
      const signal = intent.abortSignal;

      commitIsPlaying("intent", false);
      setIsDownloading(true);

      // NOTE: no page-side prefetch fetch here. The old warm-up fetch was
      // dead weight: public/sw.js answers upstream Drive fetches with
      // `cache: 'no-store'`, so a page-side Range warm-up never lands in the
      // Chromium HTTP cache (and re-enabling that cache is not safe — see the
      // sw.js comment on Chromium bug #1026867 / PIPELINE_ERROR_READ).

      const prefetchedUrl = getPrefetchedStreamUrl(targetTrack.id);

      try {
        const freshToken = await getValidToken(false, signal).catch(
          (e: unknown) => {
            if (isAbortError(e)) throw e;
            void logUsePlayer("warn", `token-refresh-fail: ${errMsg(e)}`);
            return null;
          },
        );

        // guard UTP-1: the LEAD token-refresh branch does not race the signal,
        // so an aborted attempt resumes here — never commit it. Clear the
        // spinner only while this attempt still owns it: on supersede the ref
        // already points at the newer controller, whose spinner must survive.
        if (signal.aborted) {
          if (isCurrentAttempt(signal)) setIsDownloading(false);
          return;
        }

        if (!freshToken) {
          setIsDownloading(false);
          showErrorToast(t("player.playback_failed"));
          return;
        }

        const streamUrl =
          prefetchedUrl ||
          buildStreamUrl(targetTrack.id, targetTrack.originalName);
        // R3.1a: this is the play intent's commit point — a superseded attempt
        // (newer user intent) or an epoch-invalidated one (delete/logout) must
        // not touch store/engine/recordPlay even if its token resolves late.
        const committed = commitIfCurrent(intent.id, () => {
          setCurrentTrack({ ...targetTrack, streamUrl });
          triggerReload();
          commitIsPlaying("intent", true);
        });
        if (!committed) return;

        recordPlay(targetTrack).catch((e: unknown) => {
          void logUsePlayer("warn", `recordPlay-fail: ${errMsg(e)}`);
        });

        // Why: FLAC metadata (1.5MB head + 64KB chunks + next-track
        // prefetch) races mpv's first bytes for Drive quota right when its
        // cache is empty — defer this display-only fetch until audio
        // provably flows (first-audio) or the fallback fires, so the stream
        // TTFB never competes with metadata. mpv decodes from its own
        // stream header; restoreDuration only feeds SeekBar text + session.
        const metadataAudio = AudioController.getInstance();
        onceAfterFirstAudio(metadataAudio, signal, {
          trackId: targetTrack.id,
          fallbackMs: METADATA_DEFER_FALLBACK_MS,
          onFire: () => {
            // Why: first-audio (or the fallback timer) is the "playback
            // confirmed" exit — the optimistic loading state ends HERE, not at
            // URL-set time, so the spinner/disabled play button actually cover
            // the window where the new track has produced no audio yet.
            setIsDownloading(false);
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
                    prev
                      ? { ...prev, restoreDuration: metadata.duration }
                      : prev,
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
          },
          // Why: a failed playback must not fetch display-only metadata for a
          // dead track — drop the pending fetch instead of wasting quota;
          // track change (a superseding intent aborts the previous signal) and
          // unmount (cleanup effect aborts) drop the stale track's fetch too.
          // Error/abort/track-change exit: the optimistic loading state must
          // not outlive the play attempt it belonged to.
          onDrop: () => {
            setIsDownloading(false);
          },
        });

        // Why: the SW next-track prefetch is a full-file background download
        // that raced loadfile + metadata for Drive quota inside the critical
        // first-byte window (empty mpv cache), so it waits for first-audio —
        // the same signal as the metadata defer above. "Low-priority" here
        // means timing-deferral past the critical window, not a QoS bit.
        // Why no timeout fallback (unlike metadata): nothing displayed or
        // played depends on the prefetch, so firing late into a dead/stuck
        // session only wastes quota — drop-until-signal is correct and a
        // stuck track simply never prefetches. The next track is resolved
        // fresh at fire time because the queue may change while waiting.
        // An already-fired prefetch is intentionally left running on track
        // change — there is no cancel protocol down to the SW.
        onceAfterFirstAudio(metadataAudio, signal, {
          trackId: targetTrack.id,
          onFire: () => {
            const { playbackQueue, playMode, brokenTrackIds } =
              usePlayerStore.getState();
            const freshNext = resolveNextTrack(
              playbackQueue,
              targetTrack,
              playMode,
              brokenTrackIds,
            );
            if (freshNext) prefetchTrackInServiceWorker(freshNext.id);
          },
          // Why: a failed playback must not prefetch for a dead track — the
          // next track's own play handles its own prefetch; track change
          // (a superseding intent aborts the previous signal) and unmount
          // (cleanup effect aborts) both land here — the stale track never
          // prefetches and its listeners are freed.
          onDrop: () => {},
        });
      } catch (e: unknown) {
        if (isAbortError(e)) return;
        void logUsePlayer("error", `network-playback-error: ${errMsg(e)}`);
        showErrorToast(
          t(
            "player.exception_toast",
            "An exception occurred! Open Developer Tools (Ctrl+Shift+I) for details.",
          ),
        );
        setIsDownloading(false);
      } finally {
        // The intent's async work is over — the deferred metadata/SW
        // continuations keep using its signal, but a system lane may start
        // again (the user-intent guard only covers the in-flight window).
        intent.end();
      }
    },
    [
      accessToken,
      triggerReload,
      updateQueueContext,
      setIsDownloading,
      setCurrentTrack,
      t,
    ],
  );

  return {
    handlePlayTrack,
    createAbortSignal,
    isCurrentAttempt,
  };
}
