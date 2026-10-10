import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { firstFramePresented } from "../lib/videoHost";
import { describeError } from "../lib/mpvProtocol";
import { captureError } from "../utils/errorLog";

/**
 * Rust event: the render thread handed its FIRST frame of the current media load
 * to DirectComposition. It is a one-shot, re-armed per `loadfile` and per
 * render-surface (re)creation.
 *
 * The name is part of the wire contract with `src-tauri/src/player/render/mod.rs`;
 * a test spells it out literally so the pairing cannot drift.
 */
export const VIDEO_FIRST_FRAME_EVENT = "video-first-frame";

const LOGGER_SOURCE = "videoFirstFrame";

/**
 * Has a usable video frame been presented for `mediaKey`?
 *
 * The app cannot answer this any other way: `shouldShowVideoHost` flips as soon
 * a track is SELECTED, and "the renderer is initialized" is not "a frame is
 * visible". Without this signal the page is already fully transparent (see the
 * `html.drplay-host-visible` rules in App.css) while the video rect is still
 * empty, so whatever the shell paints shows through.
 *
 * The push event is the fast path, but it is ONE-SHOT with no replay: a frame
 * presented before the listener (re)registered would be lost forever (page
 * reload while the engine kept playing, a warm-engine media switch racing the
 * re-registration). So after the listener goes live — and only then, so no
 * window exists where neither path can deliver — the hook pulls the same state
 * once via `video_host_first_frame_presented` and self-heals.
 *
 * `mediaKey` is the current media id, or `null` for no media (nothing to wait
 * for, nothing to subscribe to). Changing it RESETS the answer during render —
 * not in an effect — so the previous item's frame can never be shown for one
 * frame as the new item's video. The reset also guards both delivery paths:
 * push handler and pull result share one `markReady` whose `previous.key ===
 * mediaKey` check drops anything that raced a media switch.
 */
export function useVideoFirstFrame(mediaKey: string | null): boolean {
  const [state, setState] = useState({ key: mediaKey, hasFrame: false });
  if (state.key !== mediaKey) {
    setState({ key: mediaKey, hasFrame: false });
  }
  const hasFrame = state.key === mediaKey && state.hasFrame;

  useEffect(() => {
    if (mediaKey === null) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    // Single entry point for both the push event and the pull result: only the
    // item this state belongs to can be marked ready.
    const markReady = (): void => {
      setState((previous) =>
        previous.key === mediaKey && !previous.hasFrame
          ? { key: previous.key, hasFrame: true }
          : previous,
      );
    };

    void listen(VIDEO_FIRST_FRAME_EVENT, markReady)
      .then((stopListening) => {
        // `listen` resolves asynchronously; the effect may already be gone.
        if (disposed) {
          stopListening();
          return;
        }
        unlisten = stopListening;
        // Pull-complement: recover a one-shot signal whose event this listener
        // missed (registered after the emit). `firstFramePresented` resolves
        // false on any failure, so this can never break the push path.
        void firstFramePresented().then((presented) => {
          if (!disposed && presented) markReady();
        });
      })
      .catch((e: unknown) => {
        void captureError({
          level: "warn",
          source: LOGGER_SOURCE,
          message: `listen-failed: ${describeError(e)}`,
          kind: "video-first-frame-listen-failed",
        });
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [mediaKey]);

  return hasFrame;
}
