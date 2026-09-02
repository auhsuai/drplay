import { useEffect } from "react";
import type { RefObject } from "react";
import type { AudioController } from "../../lib/AudioController";
import { updateBufferBar } from "../../utils/bufferedRange";
import { seekRelative, SEEK_STEP_SECONDS } from "../../hooks/player/utils";

export interface UseSeekKeyboardOptions {
  audio: AudioController;
  bufferFillRef: RefObject<HTMLDivElement | null>;
  playheadRef: RefObject<number>;
  enabled: boolean;
}

export function useSeekKeyboard({
  audio,
  bufferFillRef,
  playheadRef,
  enabled,
}: UseSeekKeyboardOptions): void {
  // ArrowLeft/Right seek the track and redraw the buffer bar synchronously.
  // Lives here (not the global shortcuts hook) because it needs the local
  // bufferFillRef; global transport keys stay in useKeyboardShortcuts.
  // Gated on `keyboardSeek`: the NowPlaying instance stays silent so the
  // always-mounted PlayerBar instance is the only keydown listener (two
  // subscriptions would double the seek step).
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Meta/Alt chords belong to the app/webview, not the player
      // (Alt+Left/Right is history navigation) — return before any
      // preventDefault/seek so the chord is neither triggered nor swallowed.
      // Same rule as the transport shortcuts in useKeyboardShortcuts.ts.
      // e.repeat deliberately KEEPS seeking: holding an arrow scrubbing
      // repeatedly is the intended player convention (YouTube-style).
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl?.tagName === "INPUT" ||
        activeEl?.tagName === "TEXTAREA" ||
        activeEl?.isContentEditable
      )
        return;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          seekRelative(audio, -SEEK_STEP_SECONDS);
          // Redraw immediately instead of clearing: updateBufferBar already
          // drops stale pre-seek ranges, and clearing first would flash an
          // empty bar for a frame before the next progress event (blink on
          // every seek). The UI playhead (the position the fill still shows —
          // the fill moves on the next timeupdate) drives the stale-range
          // drop filters in the interim frame.
          updateBufferBar(
            bufferFillRef.current,
            audio.getBuffered(),
            playheadRef.current,
          );
          break;
        case "ArrowRight":
          e.preventDefault();
          seekRelative(audio, SEEK_STEP_SECONDS);
          updateBufferBar(
            bufferFillRef.current,
            audio.getBuffered(),
            playheadRef.current,
          );
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
    // bufferFillRef/playheadRef are stable ref objects — listed only to keep
    // exhaustive-deps quiet; the effect must not re-run on their identity.
  }, [audio, bufferFillRef, enabled, playheadRef]);
}
