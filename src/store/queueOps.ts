import type { Track } from "../types";
import { set as idbSet } from "../db/kv";
import { captureError } from "../utils/errorLog";
import { SESSION_CLEANUP_KEYS } from "../utils/sessionCleanup";
import {
  classifyPlayerError,
  ensureQueueItemId,
  sameTrack,
  trackKey,
} from "../hooks/player/utils";
import { usePlayerStore } from "./playerStore";

/**
 * Fire-and-forget persistence of the user-ordered queue to the kv store.
 * Failures are logged (never thrown): a failed save must not break the queue
 * edit the user just made in memory.
 */
export function persistQueue(queue: Track[]): void {
  idbSet(SESSION_CLEANUP_KEYS.queueKv, queue).catch((e: unknown) => {
    // captureError never rejects (it swallows internally), so this is safe in
    // the rejection handler.
    void captureError({
      level: "warn",
      source: "queueOps",
      message: `queue-save-fail: ${classifyPlayerError(e).message}`,
    });
  });
}

/**
 * Append tracks to the tail of both queue layers.
 * Deliberate: even in shuffle mode the new tracks go to the CURRENT playback
 * tail (no reshuffle) — predictable "plays after what is already queued".
 * Reads fresh state inside the call so a caller never acts on a stale queue.
 */
export function appendTracksToQueue(tracks: Track[]): number {
  if (tracks.length === 0) return 0;

  const state = usePlayerStore.getState();
  const newTracks = tracks.map((track) => ensureQueueItemId(track));
  const nextOriginalQueue = [...state.originalQueue, ...newTracks];

  state.setOriginalQueue(nextOriginalQueue);
  state.setPlaybackQueue([...state.playbackQueue, ...newTracks]);
  persistQueue(nextOriginalQueue);
  return newTracks.length;
}

/**
 * Remove queue entries by id from both queue layers.
 * Matching is by the stable queueItemId, falling back to the Drive track id
 * for legacy persisted entries that predate queueItemId. The currently
 * playing track is never removed, even when its id is passed in.
 */
export function removeTracksFromQueue(itemIds: readonly string[]): number {
  if (itemIds.length === 0) return 0;

  const ids = new Set(itemIds);
  const state = usePlayerStore.getState();
  const { currentTrack } = state;

  const keep = (track: Track): boolean =>
    !ids.has(trackKey(track)) ||
    (currentTrack !== null && sameTrack(track, currentTrack));

  const nextOriginalQueue = state.originalQueue.filter(keep);
  const nextPlaybackQueue = state.playbackQueue.filter(keep);
  const changed =
    nextOriginalQueue.length !== state.originalQueue.length ||
    nextPlaybackQueue.length !== state.playbackQueue.length;
  if (!changed) return 0;

  state.setOriginalQueue(nextOriginalQueue);
  state.setPlaybackQueue(nextPlaybackQueue);
  persistQueue(nextOriginalQueue);
  return state.originalQueue.length - nextOriginalQueue.length;
}

/**
 * Remove every queue entry that came from the given Drive items — the Drive
 * delete path addresses items by Drive file/folder id, while queue entries
 * are keyed by queueItemId (one per duplicate; the id survives shuffling).
 * An entry matches when the deleted id is:
 * - the entry's own Drive id (file deleted), or
 * - its `folderGroupId` (root folder added via "add folder to queue"), or
 * - its `parentId` (direct child of a deleted folder).
 * Matching keys are mapped to trackKey and delegated to
 * removeTracksFromQueue so both layers, the current-track protection and the
 * single persist write stay single-sourced. Callers run stopPlaybackIfTrack
 * first, so a deleted CURRENT track is already cleared from the store and its
 * entry is evicted too — never left behind as a dead id.
 */
export function removeTracksByDriveIds(driveIds: readonly string[]): number {
  if (driveIds.length === 0) return 0;

  const ids = new Set(driveIds);
  const { originalQueue, playbackQueue } = usePlayerStore.getState();
  const keys = new Set<string>();
  for (const track of [...originalQueue, ...playbackQueue]) {
    if (
      ids.has(track.id) ||
      (track.folderGroupId !== undefined && ids.has(track.folderGroupId)) ||
      (track.parentId !== undefined && ids.has(track.parentId))
    ) {
      keys.add(trackKey(track));
    }
  }
  return removeTracksFromQueue([...keys]);
}

/**
 * Remove every entry that came from the given Drive folder (excluding the
 * currently playing track). Matches BOTH:
 * - folderGroupId: a root folder added via "add folder to queue", whose
 *   recursive walk stamped every member (even in subfolders); and
 * - parentId: legacy behavior for direct parent-folder entries.
 * Empty/absent folderId is a defensive no-op.
 */
export function removeTracksByFolderFromQueue(folderId: string): number {
  if (!folderId) return 0;

  const { originalQueue, currentTrack } = usePlayerStore.getState();
  const ids = originalQueue
    .filter(
      (track) =>
        track.folderGroupId === folderId || track.parentId === folderId,
    )
    .filter((track) => currentTrack === null || !sameTrack(track, currentTrack))
    .map((track) => trackKey(track));

  return removeTracksFromQueue(ids);
}
