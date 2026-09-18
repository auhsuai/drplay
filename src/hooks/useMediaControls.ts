import { useCallback, useEffect, useRef } from "react";
import {
  listenMediaControls,
  updateMediaControls,
  type MediaControlPayload,
  type MediaControlsSnapshot,
} from "../lib/mediaControls";
import { AudioController } from "../lib/AudioController";
import { usePlayerStore } from "../store/playerStore";
import { seekRelative, SEEK_STEP_SECONDS } from "./player/utils";

export interface UseMediaControlsOptions {
  /** Resume/pause via the existing player toggle (covers the resume path). */
  onTogglePlay: () => void;
  /** Advance to the next track in the queue (usePlayerQueue.handleNextTrack). */
  onNext: () => void;
  /** Go back to the previous track (usePlayerQueue.handlePrevTrack). */
  onPrev: () => void;
}

/**
 * One snapshot per second is enough for the flyout timeline; the player's own
 * timeupdate throttle (200ms) would multiply IPC traffic for no visual gain.
 */
const POSITION_UPDATE_INTERVAL_MS = 1000;

type SnapshotPatch = Partial<Omit<MediaControlsSnapshot, "revision">>;

function clampPosition(position: number, duration: number): number {
  const safe = Number.isFinite(position) && position > 0 ? position : 0;
  return duration > 0 ? Math.min(safe, duration) : safe;
}

/**
 * Bridges the app-owned Windows SMTC session (media flyout / media keys) to
 * the existing player stack:
 * - OS actions (`media-control` event from Rust) call only existing public
 *   APIs — queue next/prev come from usePlayerQueue, play/pause/seek from the
 *   same handlers the on-screen controls use;
 * - player state is pushed back as revision-stamped snapshots so the flyout
 *   shows title/artist/playback/position without owning any state.
 */
export function useMediaControls(options: UseMediaControlsOptions) {
  // Action handler is registered once; the ref keeps it calling the freshest
  // callbacks (handleNextTrack & co. are recreated on every player render).
  const callbacksRef = useRef<UseMediaControlsOptions>(options);
  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  // ---- OS -> app ----
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const handlePayload = (payload: MediaControlPayload) => {
      const audio = AudioController.getInstance();
      switch (payload.action) {
        case "play":
          if (!usePlayerStore.getState().isPlaying) {
            callbacksRef.current.onTogglePlay();
          }
          break;
        case "pause":
          if (usePlayerStore.getState().isPlaying) audio.pause();
          break;
        case "toggle":
          callbacksRef.current.onTogglePlay();
          break;
        case "next":
          callbacksRef.current.onNext();
          break;
        case "previous":
          callbacksRef.current.onPrev();
          break;
        case "stop":
          // The player has no separate stop pipeline; pause mirrors what the
          // on-screen transport does for a stop request.
          audio.pause();
          break;
        case "seek":
          if (
            typeof payload.position === "number" &&
            Number.isFinite(payload.position)
          ) {
            audio.seek(payload.position);
          }
          break;
        case "seek-forward":
          seekRelative(audio, SEEK_STEP_SECONDS);
          break;
        case "seek-backward":
          seekRelative(audio, -SEEK_STEP_SECONDS);
          break;
      }
    };

    void listenMediaControls(handlePayload).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ---- app -> OS ----
  const revisionRef = useRef(0);
  const snapshotRef = useRef<Omit<MediaControlsSnapshot, "revision">>({
    title: null,
    artist: null,
    duration: null,
    playback: "stopped",
    position: null,
  });
  const lastPositionPushRef = useRef(0);

  const push = useCallback((patch: SnapshotPatch) => {
    revisionRef.current += 1;
    const snapshot: MediaControlsSnapshot = {
      ...snapshotRef.current,
      ...patch,
      revision: revisionRef.current,
    };
    snapshotRef.current = snapshot;
    void updateMediaControls(snapshot);
  }, []);

  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const isPlaying = usePlayerStore((state) => state.isPlaying);

  // Metadata/playback snapshot follows the store. A store update with the
  // same track id (parsed tags folded in by TrackInfo) refreshes title/artist.
  useEffect(() => {
    const audio = AudioController.getInstance();
    const duration = audio.getDuration();
    push({
      title: currentTrack?.title ?? null,
      artist: currentTrack?.artist ?? null,
      duration:
        duration > 0 ? duration : (currentTrack?.restoreDuration ?? null),
      playback: currentTrack ? (isPlaying ? "playing" : "paused") : "stopped",
      position: currentTrack
        ? clampPosition(audio.getCurrentTime(), duration)
        : null,
    });
  }, [currentTrack, isPlaying, push]);

  // Position snapshot: reuse AudioController's 200ms timeupdate throttle plus
  // its post-seek progress re-emit, but push at most once per second.
  useEffect(() => {
    if (!currentTrack) return;
    const audio = AudioController.getInstance();
    const tick = () => {
      const now = Date.now();
      if (now - lastPositionPushRef.current < POSITION_UPDATE_INTERVAL_MS) {
        return;
      }
      lastPositionPushRef.current = now;
      const duration = audio.getDuration();
      const position = clampPosition(audio.getCurrentTime(), duration);
      if (duration > 0) push({ position, duration });
      else push({ position });
    };
    const unsubTime = audio.on("timeupdate", tick);
    const unsubProgress = audio.on("progress", tick);
    return () => {
      unsubTime();
      unsubProgress();
    };
  }, [currentTrack, push]);
}
