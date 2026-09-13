/**
 * A playable audio item (or the audio half of a Drive item). The minimal
 * contract every consumer agrees on: identity, display title/artist, and
 * where the stream comes from.
 */
export type Track = {
  id: string;
  title: string;
  artist: string;
  streamUrl: string;
  size?: number | undefined;
  originalName?: string;
  restoreTime?: number;
  restoreDuration?: number;
  parentId?: string;
  parentName?: string;
  queueItemId?: string;
  // Stamped ONLY by collectFolderTracks: the root folder the user picked for
  // "add folder to queue". Every recursively collected member shares this id
  // so the queue can collapse a whole added tree into one folder entry, while
  // parentId/parentName keep pointing at the direct containing folder.
  folderGroupId?: string;
  folderGroupName?: string;
};

/** The signed-in Google account's display profile. */
export type UserProfile = {
  name: string;
  email: string;
  picture: string;
};

export type PlayMode = "normal" | "shuffle" | "repeat-all" | "repeat-one";

/**
 * A row in the Drive explorer listing: a folder or a file, with optional
 * audio metadata attached for files (trackInfo is undefined for folders).
 */
// moved from App.tsx
export type DriveItem = {
  id: string;
  title: string;
  isFolder: boolean;
  trackInfo?: Track | undefined;
  size?: number | undefined;
  modifiedTime?: string | undefined;
  // Real Drive parent id, kept top-level (not in trackInfo) so folder hits
  // from global search can carry it while trackInfo stays undefined for
  // folders. Absent for rows whose parent is unknown.
  parentId?: string | undefined;
};

// moved from App.tsx
export type BreadcrumbItem = {
  id: string;
  name: string;
};

// Canonical definition lives in utils/driveConstants.ts (TABS const + TabKey
// derive from the same literal values). Re-exported here so type-only
// consumers can keep importing from './types'.
export type { TabKey } from "./utils/driveConstants";
