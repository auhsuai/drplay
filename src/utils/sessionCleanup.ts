import { captureError } from './errorLog';
import { del as kvDel } from '../db/kv';

// Session data lives in two places: localStorage (drplay_last_session,
// written by usePlayerSession; drplay_sort_option — per-account folder-view
// sort preference written by App.tsx) and the kv store (drplay_playmode by
// usePlayer, drplay_queue by usePlayerQueue). Logout MUST clear all of them
// or a previous user's session (track/queue/playmode/sort) resurrects in the
// next account.
export const SESSION_CLEANUP_KEYS = {
  lastSessionLocalStorage: 'drplay_last_session',
  sortOptionLocalStorage: 'drplay_sort_option',
  lastSessionKv: 'drplay_last_session',
  playModeKv: 'drplay_playmode',
  queueKv: 'drplay_queue',
} as const;

export function clearSessionState(): void {
  localStorage.removeItem(SESSION_CLEANUP_KEYS.lastSessionLocalStorage);
  localStorage.removeItem(SESSION_CLEANUP_KEYS.sortOptionLocalStorage);
  Promise.allSettled([
    kvDel(SESSION_CLEANUP_KEYS.lastSessionKv),
    kvDel(SESSION_CLEANUP_KEYS.playModeKv),
    kvDel(SESSION_CLEANUP_KEYS.queueKv),
  ]).then((results) => {
    results.forEach((r) => {
      if (r.status === 'rejected') {
        captureError({ source: 'sessionCleanup', message: `logout-cleanup-failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, kind: 'logout-cleanup-failed' });
      }
    });
  });
}
