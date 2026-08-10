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
