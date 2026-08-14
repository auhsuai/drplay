import { AudioController } from "../lib/AudioController";
import { usePlayerStore } from "../store/playerStore";

/**
 * Stop playback immediately when a file is deleted from Drive while it is the
 * track currently loaded in the player: the app must never keep playing audio
 * that no longer exists (user decision: "no app lets you listen to a deleted
 * track"). Fully releases the audio engine (both elements paused, src dropped,
 * pending retry cancelled — same B3 pattern as the player-stop logout path,
 * AudioController.release()), then clears the store so the PlayerBar falls
 * back to "no track playing". Deliberately silent — the user just asked to
 * delete the file, so no toast. No-op when the deleted file is not the
 * current track.
 */
export function stopPlaybackIfTrack(fileId: string): void {
  if (usePlayerStore.getState().currentTrack?.id !== fileId) return;
  AudioController.getInstance().release();
  usePlayerStore.getState().setCurrentTrack(null);
  usePlayerStore.getState().setIsPlaying(false);
}
