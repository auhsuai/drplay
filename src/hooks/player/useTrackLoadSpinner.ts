import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Track } from "../../types";

/**
 * Track-change loading spinner state, shared by PlayerBar and NowPlayingView.
 *
 * True from the moment the store points at a new track/nonce mid-play until
 * the engine proves an outcome (play, error or pause). Pure UI feedback.
 *
 * The arm/clear runs during render (React "adjusting state during render"
 * pattern) so no setState happens synchronously inside an effect
 * (react-hooks/set-state-in-effect). The load key `${track.id}:${loadNonce}`
 * identifies one playback attempt: a key change while playing means the
 * engine is about to load new audio — arm the spinner immediately (the
 * engine's own buffering event may lag or never fire for native players).
 * The ref syncs even when paused so a later resume never sees a stale key;
 * pausing clears a pending spinner here instead of an effect.
 */
export function useTrackLoadSpinner(
  currentTrack: Track | null,
  loadNonce: number | undefined,
  isPlaying: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [isLoadingTrack, setIsLoadingTrack] = useState(false);

  const prevLoadKeyRef = useRef<string | undefined>(undefined);
  const loadKey = currentTrack
    ? `${currentTrack.id}:${String(loadNonce ?? 0)}`
    : undefined;
  if (loadKey !== prevLoadKeyRef.current) {
    prevLoadKeyRef.current = loadKey;
    if (currentTrack && isPlaying && !isLoadingTrack) setIsLoadingTrack(true);
  } else if (!isPlaying && isLoadingTrack) {
    setIsLoadingTrack(false);
  }

  return [isLoadingTrack, setIsLoadingTrack];
}
