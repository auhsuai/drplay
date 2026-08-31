// Single source of truth: every localStorage key is defined ONCE in
// utils/storageKeys.ts. The LS_* exports below are kept as stable aliases
// so existing consumers (App.tsx, TabContentRouter) need no change — they
// now resolve to the storageKeys definitions instead of duplicated
// literals. A drift between the two names would be caught by the dedup
// lock test (appUiState.test.ts).
import {
  BACKGROUND_PLAYBACK_KEY,
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  DB_NAV_STATE_KEY,
  FOLDER_HISTORY_KEY,
  ROOT_FOLDER_KEY,
  SORT_OPTION_KEY,
} from "./utils/storageKeys";

export const LS_ROOT_FOLDER = ROOT_FOLDER_KEY;
export const LS_CURRENT_FOLDER_ID = CURRENT_FOLDER_ID_KEY;
export const LS_CURRENT_FOLDER_NAME = CURRENT_FOLDER_NAME_KEY;
export const LS_FOLDER_HISTORY = FOLDER_HISTORY_KEY;
export const LS_SORT_OPTION = SORT_OPTION_KEY;
export const LS_BACKGROUND_PLAYBACK = BACKGROUND_PLAYBACK_KEY;
export { DB_NAV_STATE_KEY };

// Lazy-useState-compatible reader for the mobile background-playback
// preference (Task 3 mobile-polish): missing key (first launch) defaults to
// ON — native audio keeps playing when the app is backgrounded (foreground
// service), the toggle OFF opt-in pauses on hidden. localStorage access can
// throw SecurityError (storage blocked by policy — see MDN
// Window.localStorage), so the read is guarded and falls back to the default
// like a missing key.
export function loadBackgroundPlaybackState(): boolean {
  try {
    const saved = localStorage.getItem(LS_BACKGROUND_PLAYBACK);
    return saved !== null ? saved === "true" : true;
  } catch {
    return true; // storage blocked — default behavior (same as missing key)
  }
}
