import { useEffect } from "react";
import { usePlayerStore } from "../store/playerStore";
import { IS_MOBILE } from "../utils/platform";

/**
 * Task 3 mobile-polish — "Chạy nhạc nền" (background playback) toggle.
 *
 * Mobile only (desktop registers nothing — tray behavior untouched). When the
 * toggle is OFF and a track is playing, hiding the app (Android home button
 * backgrounding the WebView → visibilitychange → hidden) pauses playback; the
 * latch remembers the pause so returning to the app (visible) resumes it. When
 * the toggle is ON (default), nothing is touched: the plugin's foreground
 * service keeps the audio running in the background (current behavior).
 *
 * The hook does NOT call the engine directly — it flips the store isPlaying
 * flag, and the PlayerBar "Handle Play/Pause from Props" effect (the single
 * source of truth for engine transport calls) translates that into
 * engine.pause() / engine.playTrack() exactly like a UI pause/resume would.
 * The native state events then echo the engine state back into the store.
 */

export type BackgroundPlaybackDecision = "pause" | "resume" | "none";

/** Pure decision helper (exported for unit tests):
 *  - toggle ON → never touch playback (foreground service owns it);
 *  - hidden + playing → pause (remember we paused it);
 *  - visible + was playing → resume;
 *  - nothing playing → no-op either way. */
export function backgroundPlaybackDecision(input: {
  hidden: boolean;
  playing: boolean;
  toggleOn: boolean;
}): BackgroundPlaybackDecision {
  if (input.toggleOn) return "none";
  if (input.hidden && input.playing) return "pause";
  if (!input.hidden && input.playing) return "resume";
  return "none";
}

export function useBackgroundPlayback(toggleOn: boolean): void {
  useEffect(() => {
    if (!IS_MOBILE) return;

    // Latch: true while WE paused playback for the background; consumed by
    // the first visible event. If the user resumed from the media
    // notification while hidden, the store isPlaying flips true again and
    // the resume guard below skips (no double-resume).
    let pausedForBackground = false;

    const onVisibilityChange = () => {
      const hidden = document.visibilityState === "hidden";
      const decision = backgroundPlaybackDecision({
        hidden,
        playing: hidden
          ? usePlayerStore.getState().isPlaying
          : pausedForBackground,
        toggleOn,
      });

      if (decision === "pause") {
        pausedForBackground = true;
        usePlayerStore.getState().setIsPlaying(false);
      } else if (decision === "resume") {
        pausedForBackground = false;
        const state = usePlayerStore.getState();
        // currentTrack null (user stopped it via notification) or already
        // playing (user resumed via notification) → nothing to resume.
        if (state.currentTrack && !state.isPlaying) {
          state.setIsPlaying(true);
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [toggleOn]);
}
