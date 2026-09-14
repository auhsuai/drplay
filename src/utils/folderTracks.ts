import type { Track } from "../types";
import { FOLDER_MIME } from "./driveTypes";
import { hasAudioExtension } from "./audioQuery";
import { stripAudioExtension } from "./pathUtils";
import { listFolderAudioFiles } from "./drivePagination";

// Safety cap for "add folder to queue": a huge Drive tree must not append an
// unbounded number of items in one action. Hitting the cap stops the walk
// immediately and reports truncation so the caller can tell the user.
export const MAX_ADD_TO_QUEUE_TRACKS = 1000;

// Second safety cap: a folder-only tree (many folders, few/none audio files)
// never grows `tracks`, so the track cap alone still lets the walk issue one
// Drive listing per folder without bound. Each listed folder costs at least
// one files.list request (100 quota units), so 1000 folders ≈ 100k units —
// same scale as the track cap and comfortably below Drive's 325k units/min
// per-user limit even when folders paginate. Hitting it stops the walk and
// reports truncation through the existing `truncated` flag.
export const MAX_WALKED_FOLDERS = 1000;

export interface CollectedFolderTracks {
  tracks: Track[];
  truncated: boolean;
}

interface PendingFolder {
  id: string;
  name: string;
}

// Mirrors workers/driveMapping.ts toSize: a malformed size string must become
// undefined, never NaN (Track.size is number | undefined).
function toSize(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const size = parseInt(raw, 10);
  return Number.isFinite(size) ? size : undefined;
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
  // A stale or malformed listing can repeat a folder id or form a cycle
  // (A -> B -> A); mark ids as visited before enqueueing so the walk is
  // bounded by the number of distinct folders instead of looping forever.
  const visited = new Set<string>([rootFolderId]);
  let foldersWalked = 0;

  while (pending.length > 0) {
    signal?.throwIfAborted();
    // Folders discovered but not listed yet: stop before the listing request
    // so the walk issues at most MAX_WALKED_FOLDERS Drive calls.
    if (foldersWalked >= MAX_WALKED_FOLDERS) {
      return { tracks, truncated: true };
    }
    const folder = pending.shift();
    if (folder === undefined) break;
    foldersWalked++;

    const entries = await listFolderAudioFiles(token, folder.id, signal);
    // fetchAllPages can resolve with a partial page list once its signal
    // aborts between pages; an aborted walk must never look successful.
    signal?.throwIfAborted();

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry === undefined) continue;
      if (entry.mimeType === FOLDER_MIME) {
        if (visited.has(entry.id)) continue;
        visited.add(entry.id);
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
        size: toSize(entry.size),
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
