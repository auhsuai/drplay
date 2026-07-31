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
  coverUrl?: string;
  dbId?: string;
  queueItemId?: string;
};

export type UserProfile = {
  name: string;
  email: string;
  picture: string;
};

export type PlayMode = 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
