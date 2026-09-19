import { AudioController } from "../lib/AudioController";
import { usePlayerStore } from "../store/playerStore";
import { commitIsPlaying } from "../store/playbackCommit";
import { bumpSessionEpoch } from "../hooks/player/playbackIntent";

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
  // R3.1a (SC3): invalidate + abort every in-flight intent BEFORE the engine
  // is released — a play attempt still awaiting its token must not resurrect
  // the deleted file (commitIfCurrent is dead from here on), and the engine
  // must not receive a loadfile for a file that no longer exists.
  bumpSessionEpoch();
  AudioController.getInstance().release();
  usePlayerStore.getState().setIsDownloading(false);
  usePlayerStore.getState().setCurrentTrack(null);
  commitIsPlaying("teardown", false);
}
