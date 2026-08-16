import { useCallback, useEffect, useRef } from "react";
import { usePlayerStore } from "../store/playerStore";
import { getPlaybackEngine } from "../lib/nativeAudioBridge";
import { seekRelative, SEEK_STEP_SECONDS } from "./player/utils";

export interface UseMediaSessionOptions {
  /** Resume playback (usePlayer.handleTogglePlay — covers the no-streamUrl resume path). */
  onTogglePlay: () => void;
  /** Advance to the next track in the queue (usePlayerQueue.handleNextTrack). */
  onNext: () => void;
  /** Go back to the previous track (usePlayerQueue.handlePrevTrack). */
  onPrev: () => void;
}

/**
 * Media Session API actions this app handles. Registered once on mount — MDN
 * / web.dev: action handlers persist through playbacks; unsetting is done
 * with `setActionHandler(action, null)` on unmount.
 */
const MEDIA_SESSION_ACTIONS: ReadonlyArray<MediaSessionAction> = [
  "play",
  "pause",
  "nexttrack",
  "previoustrack",
  "seekto",
  "seekbackward",
  "seekforward",
];

/** The app never changes playback speed (no playbackRate API) → always 1. */
const PLAYBACK_RATE = 1;

function getMediaSession(): MediaSession | null {
  // Guard: WebView2/Chromium expose it; older engines and test envs do not.
  return "mediaSession" in navigator ? navigator.mediaSession : null;
}

/**
 * Bridges the OS media surface (Windows flyout / SMTC, keyboard media keys)
 * to the existing player stack. Pure React hook: subscribes to the player
 * store and engine events (getPlaybackEngine — AudioController on desktop,
 * native ExoPlayer engine on mobile), calls only existing public APIs — it
 * never starts a new playback pipeline of its own.
 */
export function useMediaSession(options: UseMediaSessionOptions) {
  // Action handlers are registered once on mount; the ref keeps them calling
  // the freshest callbacks (handleNextTrack & co. are recreated on every
  // player render). Ref is written only inside an effect (React Compiler-safe).
  const callbacksRef = useRef<UseMediaSessionOptions>(options);
  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  const updatePositionState = useCallback(() => {
    const session = getMediaSession();
    if (!session) return;
    const audio = getPlaybackEngine();
    const duration = audio.getDuration();
    const position = audio.getCurrentTime();
    // setPositionState throws TypeError when duration <= 0, position < 0 or
    // position > duration (MDN) — guard every call.
    if (duration <= 0 || position < 0 || position > duration) return;
    try {
      session.setPositionState({
        duration,
        position,
        playbackRate: PLAYBACK_RATE,
      });
    } catch {
      // Older user agents without setPositionState support: no-op.
    }
  }, []);

  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;

    const register = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Some user agents throw for actions they do not support (MDN pattern).
      }
    };

    register("play", () => {
      if (!usePlayerStore.getState().isPlaying) {
        callbacksRef.current.onTogglePlay();
      }
    });
    register("pause", () => {
      if (usePlayerStore.getState().isPlaying) {
        void getPlaybackEngine().pause();
      }
    });
    register("nexttrack", () => {
      callbacksRef.current.onNext();
    });
    register("previoustrack", () => {
      callbacksRef.current.onPrev();
    });
    register("seekto", (details) => {
      if (details.seekTime === undefined) return;
      void getPlaybackEngine().seek(details.seekTime);
      updatePositionState();
    });
    register("seekbackward", (details) => {
      const audio = getPlaybackEngine();
      seekRelative(audio, -(details.seekOffset ?? SEEK_STEP_SECONDS));
      updatePositionState();
    });
    register("seekforward", (details) => {
      const audio = getPlaybackEngine();
      seekRelative(audio, details.seekOffset ?? SEEK_STEP_SECONDS);
      updatePositionState();
    });

    return () => {
      for (const action of MEDIA_SESSION_ACTIONS) register(action, null);
      try {
        // Empty state object clears the position (MDN); passed as {} because
        // lib.dom types do not model the null-clearing form.
        session.setPositionState({});
      } catch {
        // Older user agents: no-op.
      }
      session.metadata = null;
    };
  }, [updatePositionState]);

  // Metadata follows the current track. web.dev: metadata persists across
  // playbacks, so it must be updated whenever the source changes.
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;
    if (!currentTrack) {
      session.metadata = null;
      return;
    }
    // album/artwork are intentionally omitted: the Track type has no album
    // and no valid artwork source — never fabricate a URL.
    session.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
    });
  }, [currentTrack]);

  // playbackState mirrors the store; "none" when nothing is loaded (MDN).
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;
    session.playbackState = currentTrack
      ? isPlaying
        ? "playing"
        : "paused"
      : "none";
  }, [currentTrack, isPlaying]);

  // Position state: reuse the engine's built-in 200ms timeupdate throttle
  // and its post-seek "progress" re-emits (seeked) — no timer of our own.
  // Guarded like the others: no mediaSession → no subscription at all.
  useEffect(() => {
    if (!getMediaSession()) return;
    const audio = getPlaybackEngine();
    const unsubTime = audio.on("timeupdate", updatePositionState);
    const unsubProgress = audio.on("progress", updatePositionState);
    return () => {
      unsubTime();
      unsubProgress();
    };
  }, [updatePositionState]);
}
