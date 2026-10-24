import { useEffect, useState } from "react";
import type { AudioController } from "../../../lib/AudioController";
import { isForeignTrackEvent } from "../../../lib/audioNativeEvents";
import type { Track } from "../../../types";
import { formatTime } from "../../../utils/formatTime";

export interface VideoTimeDisplayProps {
  currentTrack: Track;
  audio: AudioController;
  /** Gate the 4/s timeupdate subscription (same contract as SeekBar). */
  active?: boolean;
}

interface ClockState {
  trackId: string;
  currentTime: number;
  duration: number;
}

/** Clamp anything the engine/restore data can hand us into a displayable
 *  non-negative finite number. */
function safeTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function initialClock(track: Track): ClockState {
  return {
    trackId: track.id,
    currentTime: safeTime(track.restoreTime ?? 0),
    duration: safeDuration(track.restoreDuration ?? 0),
  };
}

/**
 * The video bar's `current / total` read-out. Leaf component: it owns its
 * state + subscription so the 4/s timeupdate re-renders this span only, never
 * VideoPlayerBar or the video surface. The engine is the only clock — no
 * setInterval, no artificial ticking.
 */
export function VideoTimeDisplay({
  currentTrack,
  audio,
  active = true,
}: VideoTimeDisplayProps) {
  const [clock, setClock] = useState<ClockState>(() =>
    initialClock(currentTrack),
  );

  // Reset the clock when the track changes. Done during render (React
  // "adjusting state during render" pattern) so no setState happens
  // synchronously inside an effect (react-hooks/set-state-in-effect).
  const [lastTrackId, setLastTrackId] = useState(currentTrack.id);
  if (lastTrackId !== currentTrack.id) {
    setLastTrackId(currentTrack.id);
    setClock(initialClock(currentTrack));
  }

  useEffect(() => {
    const trackId = currentTrack.id;
    const isForeign = (payload: { trackId?: string } | undefined): boolean =>
      isForeignTrackEvent(payload, trackId);

    // One-shot resync from the engine (mount / view open / track switch).
    // Only when the engine really is on THIS track — never borrow another
    // video's time.
    const engineDuration = audio.getDuration();
    if (
      audio.getCurrentTrackId() === trackId &&
      Number.isFinite(engineDuration) &&
      engineDuration > 0
    ) {
      // One-shot seed from the external engine (an external store, not state
      // derived from props); without it a paused view opened mid-track shows
      // 0:00 until the next event, which may never come.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClock({
        trackId,
        currentTime: safeTime(audio.getCurrentTime()),
        duration: engineDuration,
      });
    }

    // The total must be right while paused too: durationchange is NOT gated
    // on `active`.
    const unsubDuration = audio.on("durationchange", (payload) => {
      if (isForeign(payload)) return;
      const { duration } = payload;
      if (!Number.isFinite(duration) || duration < 0) return;
      setClock((prev) =>
        prev.trackId === trackId ? { ...prev, duration } : prev,
      );
    });

    let unsubTime: (() => void) | undefined;
    if (active) {
      unsubTime = audio.on("timeupdate", (payload) => {
        if (isForeign(payload)) return;
        const { currentTime, duration } = payload;
        if (!Number.isFinite(currentTime)) return;
        setClock((prev) => {
          if (prev.trackId !== trackId) return prev;
          return {
            ...prev,
            currentTime: safeTime(currentTime),
            duration:
              Number.isFinite(duration) && duration > 0
                ? duration
                : prev.duration,
          };
        });
      });
    }

    return () => {
      unsubDuration();
      unsubTime?.();
    };
  }, [audio, active, currentTrack.id]);

  return (
    <span
      data-testid="video-time-display"
      className="text-xs text-gray-500 tabular-nums whitespace-nowrap shrink-0"
    >
      {formatTime(clock.currentTime)} /{" "}
      {clock.duration > 0 ? formatTime(clock.duration) : "--:--"}
    </span>
  );
}
