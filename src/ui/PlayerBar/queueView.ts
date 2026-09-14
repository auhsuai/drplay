import type { Track } from "../../types";
import { sameTrack, trackKey } from "../../hooks/player/utils";

/**
 * One row of the Play Queue: either a real queue track or a collapsed folder
 * group produced by "add folder to queue" (collectFolderTracks stamp).
 */
export type QueueViewItem =
  | { kind: "track"; key: string; track: Track }
  | {
      kind: "folder";
      key: string;
      folderId: string;
      folderName: string;
      count: number;
      containsCurrent: boolean;
    };

const folderKey = (folderId: string): string => `folder:${folderId}`;

/**
 * Pure projection of the playback queue for the queue panel.
 * - openFolderId === null: root view. Each folderGroupId collapses into one
 *   folder row at its FIRST member's position (even when shuffle scattered
 *   the members); all members are hidden. Loose tracks keep their positions.
 * - openFolderId !== null: drill-down view of exactly that group's members
 *   in queue order. Unknown id → [].
 */
export function buildQueueView(
  tracks: Track[],
  openFolderId: string | null,
  currentTrack: Track | null,
): QueueViewItem[] {
  if (openFolderId !== null) {
    return tracks
      .filter((track) => track.folderGroupId === openFolderId)
      .map((track) => ({ kind: "track", key: trackKey(track), track }));
  }

  // Aggregate group metadata first: a member may appear anywhere in the
  // queue, but its folder row must carry the whole group's count and
  // current-track status.
  const counts = new Map<string, number>();
  const currentFolders = new Set<string>();
  for (const track of tracks) {
    const folderId = track.folderGroupId;
    if (!folderId) continue;
    counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    if (currentTrack !== null && sameTrack(track, currentTrack)) {
      currentFolders.add(folderId);
    }
  }

  const emitted = new Set<string>();
  const items: QueueViewItem[] = [];
  for (const track of tracks) {
    const folderId = track.folderGroupId;
    if (!folderId) {
      items.push({ kind: "track", key: trackKey(track), track });
      continue;
    }
    if (emitted.has(folderId)) continue;
    emitted.add(folderId);
    items.push({
      kind: "folder",
      key: folderKey(folderId),
      folderId,
      // First member wins even when its name is empty: it is the folder the
      // user actually clicked.
      folderName: track.folderGroupName ?? "",
      count: counts.get(folderId) ?? 0,
      containsCurrent: currentFolders.has(folderId),
    });
  }
  return items;
}
