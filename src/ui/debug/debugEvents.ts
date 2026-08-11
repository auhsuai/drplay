export const DEBUG_EVENTS = {
  RATE_LIMIT: "drplay:debug:rate-limit",
  PLAYER_ERROR: "drplay:debug:player-error",
  QUOTA: "drplay:debug:quota",
  PLAYLIST_EMPTY: "drplay:debug:playlist-empty",
  LIKED_EMPTY: "drplay:debug:liked-empty",
  TRASH_EMPTY: "drplay:debug:trash-empty",
  FOLDERS_EMPTY: "drplay:debug:folders-empty",
  SKELETON: "drplay:debug:skeleton",
  DOWNLOAD_TOAST: "drplay:debug:download-toast",
  BULK_DELETE: "drplay:debug:bulk-delete",
  SELECTION_MODE: "drplay:debug:selection-mode",
  PAGINATION: "drplay:debug:pagination",
} as const;

export interface DebugEventMap {
  [DEBUG_EVENTS.RATE_LIMIT]: undefined;
  [DEBUG_EVENTS.PLAYER_ERROR]: { code: string; message: string };
  [DEBUG_EVENTS.QUOTA]: { usageInDrive: number; limit: number | null };
  [DEBUG_EVENTS.PLAYLIST_EMPTY]: undefined;
  [DEBUG_EVENTS.LIKED_EMPTY]: undefined;
  [DEBUG_EVENTS.TRASH_EMPTY]: undefined;
  [DEBUG_EVENTS.FOLDERS_EMPTY]: undefined;
  [DEBUG_EVENTS.SKELETON]: {
    target: "main-content" | "trash" | "folders" | "home";
  };
  [DEBUG_EVENTS.DOWNLOAD_TOAST]: { message: string };
  [DEBUG_EVENTS.BULK_DELETE]: undefined;
  [DEBUG_EVENTS.SELECTION_MODE]: undefined;
  [DEBUG_EVENTS.PAGINATION]: undefined;
}

// Same window-CustomEvent pattern the rest of the app uses (favorites.ts,
// playlists.ts, upload/events.ts): a plain dispatch, no try/catch — dispatching
// without listeners is a safe no-op, and a throw here would be a real bug that
// must surface instead of being swallowed.
export function dispatchDebugEvent<K extends keyof DebugEventMap>(
  name: K,
  detail: DebugEventMap[K],
): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// DEV-only subscribe helper shared by every debug listener (App rate-limit,
// PlayerBar player-error, ...). Guards itself with import.meta.env.DEV: in a
// production build it is a no-op that never touches window, so the shipped
// app carries zero listener overhead. Returns the unsubscribe function for
// effect cleanup (a plain window event listener — no error paths, no try/catch).
export function onDebugEvent<K extends keyof DebugEventMap>(
  name: K,
  handler: (detail: DebugEventMap[K]) => void,
): () => void {
  if (!import.meta.env.DEV) {
    return () => {};
  }
  const listener = (event: Event) => {
    handler((event as CustomEvent<DebugEventMap[K]>).detail);
  };
  window.addEventListener(name, listener);
  return () => {
    window.removeEventListener(name, listener);
  };
}
