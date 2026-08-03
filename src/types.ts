export type Track = {
  id: string;
  title: string;
  artist: string;
  streamUrl: string;
  size?: number;
  originalName?: string;
  restoreTime?: number;
  restoreDuration?: number;
  parentId?: string;
  parentName?: string;
  queueItemId?: string;
};

export type UserProfile = {
  name: string;
  email: string;
  picture: string;
};

export type PlayMode = 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';

// moved from App.tsx
export type DriveItem = {
  id: string;
  title: string;
  isFolder: boolean;
  trackInfo?: Track;
  size?: number;
  modifiedTime?: string;
};

// moved from App.tsx
export type BreadcrumbItem = {
  id: string;
  name: string;
};

// Canonical definition lives in utils/driveConstants.ts (TABS const + TabKey
// derive from the same literal values). Re-exported here so type-only
// consumers can keep importing from './types'.
export type { TabKey } from './utils/driveConstants';
