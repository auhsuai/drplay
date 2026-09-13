import type { Track } from "../types";
import { FOLDER_MIME } from "./driveTypes";
import { hasAudioExtension } from "./audioQuery";
import { stripAudioExtension } from "./pathUtils";
import { listFolderAudioFiles } from "./drivePagination";

// Safety cap for "add folder to queue": a huge Drive tree must not append an
// unbounded number of items in one action. Hitting the cap stops the walk
// immediately and reports truncation so the caller can tell the user.
export const MAX_ADD_TO_QUEUE_TRACKS = 1000;

export interface CollectedFolderTracks {
  tracks: Track[];
  truncated: boolean;
}

interface PendingFolder {
  id: string;
  name: string;
}

// Throwing (not returning partial data) on abort: fetchAllPages can resolve
// with a partial page list once its signal aborts between pages, and an
// aborted walk must never look like a successful one. Reuses the signal's
// reason when it is an Error so the caller's isAbortError check still works.
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

/**
 * Walk a Drive folder tree breadth-first and collect every playable audio
 * file as a queue Track (parentId/parentName point at the containing folder).
 * Every track is also stamped with the root folder as folderGroupId/Name so
 * the queue can collapse the whole walk into one folder entry.
 * An explicit FIFO queue keeps this iterative — a deep tree cannot overflow
 * the call stack. Listing errors and aborts propagate to the caller.
 */
export async function collectFolderTracks(
  token: string,
  rootFolderId: string,
  rootFolderName: string,
  signal?: AbortSignal,
): Promise<CollectedFolderTracks> {
  const tracks: Track[] = [];
  const pending: PendingFolder[] = [{ id: rootFolderId, name: rootFolderName }];

  while (pending.length > 0) {
    throwIfAborted(signal);
    const folder = pending.shift();
    if (folder === undefined) break;

    const entries = await listFolderAudioFiles(token, folder.id, signal);
    throwIfAborted(signal);

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry === undefined) continue;
      if (entry.mimeType === FOLDER_MIME) {
        pending.push({ id: entry.id, name: entry.name });
        continue;
      }
      // Defensive: the query already filters by extension, but a malformed or
      // stale response must not queue something WebView2 cannot decode.
      if (!hasAudioExtension(entry.name)) continue;

      tracks.push({
        id: entry.id,
        title: stripAudioExtension(entry.name),
        artist: "",
        streamUrl: "",
        size: entry.size ? parseInt(entry.size, 10) : undefined,
        originalName: entry.name,
        parentId: folder.id,
        parentName: folder.name,
        // Group stamp = the root folder of THIS walk, not the direct parent:
        // the queue renders one folder entry per add-to-queue action.
        folderGroupId: rootFolderId,
        folderGroupName: rootFolderName,
      });

      if (tracks.length >= MAX_ADD_TO_QUEUE_TRACKS) {
        return { tracks, truncated: true };
      }
    }
  }

  return { tracks, truncated: false };
}
