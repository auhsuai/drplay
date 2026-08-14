import { AudioController } from "../lib/AudioController";
import { usePlayerStore } from "../store/playerStore";
import { deleteFile } from "./driveApi";
import { captureError } from "./errorLog";

// File ids whose Drive trash is deferred until the currently-playing track
// finishes or the user switches to another track. Module-level shared state
// (app-wide, like uploadManager) — a file can only be deleted once.
const deferredFileIds = new Set<string>();

export function isDeferredTrash(fileId: string): boolean {
  return deferredFileIds.has(fileId);
}

/**
 * Trash a Drive file — or defer it when the file is the currently-playing
 * track. Drive blocks media downloads of trashed files (404 notFound), so
 * trashing a playing track would kill its stream at the next chunk fetch.
 * The deferral waits for `ended` (playback finished) or `play` after the user
 * has moved to another track, then trashes in the background.
 * @param fileId The id to trash.
 * @param token Drive access token.
 */
export function trashOrDefer(fileId: string, token: string): Promise<void> {
  if (usePlayerStore.getState().currentTrack?.id !== fileId) {
    // Return the delete promise DIRECTLY (no extra microtask hop) so the
    // caller's await chain resumes with exactly the same timing as the old
    // `await deleteFile(...)` — bulk drain loops depend on the next delete
    // being issued in the same microtask as the previous one settling. The
    // resolved DriveFileItem is discarded (callers never read it).
    return deleteFile(token, fileId) as unknown as Promise<void>;
  }

  // Already deferred for this file (double-delete of the same id) — a second
  // listener pair must not be registered.
  if (deferredFileIds.has(fileId)) return Promise.resolve();

  deferredFileIds.add(fileId);
  const audio = AudioController.getInstance();

  // Unsubscribers collected so fire() can detach both listeners in one pass.
  const unsubs: Array<() => void> = [];

  const fire = () => {
    for (const off of unsubs) off();
    // Set.delete both unsubscribes the intent and guards against a
    // re-entrant fire (ended + queued play for the same file).
    if (!deferredFileIds.delete(fileId)) return;
    void (async () => {
      try {
        await deleteFile(token, fileId);
      } catch (e: unknown) {
        void captureError({
          level: "warn",
          source: "deferredTrash",
          message: `deferred-trash failed for ${fileId}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
  };

  // `play` fires on ANY transition to playing — including resuming the SAME
  // track. Trashing a still-playing file would re-break its stream, so only
  // fire once the user has moved on (currentTrack no longer matches).
  const onPlay = () => {
    if (usePlayerStore.getState().currentTrack?.id !== fileId) fire();
  };

  unsubs.push(audio.on("ended", fire));
  unsubs.push(audio.on("play", onPlay));
  return Promise.resolve();
}
