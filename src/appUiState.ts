export const LS_ROOT_FOLDER = "drplay_root_folder";
export const LS_CURRENT_FOLDER_ID = "drplay_current_folder_id";
export const LS_CURRENT_FOLDER_NAME = "drplay_current_folder_name";
export const LS_FOLDER_HISTORY = "drplay_folder_history";
export const LS_SORT_OPTION = "drplay_sort_option";
export const LS_MINIMIZE_TO_TRAY = "drplay_minimize_to_tray";
export const LS_BACKGROUND_PLAYBACK = "drplay_background_playback";
export const DB_NAV_STATE_KEY = "drplay_nav_state";

// Lazy-useState-compatible reader for the tray-minimize preference: missing
// key (first launch) defaults to minimized; only the literal 'true' means
// minimized, any other stored value ('false'/corrupt) means not-minimized.
// localStorage access can throw SecurityError (storage blocked by policy —
// see MDN Window.localStorage), so the read is guarded and falls back to the
// default like a missing key.
export function loadMinimizeToTrayState(): boolean {
  try {
    const saved = localStorage.getItem(LS_MINIMIZE_TO_TRAY);
    return saved !== null ? saved === "true" : true;
  } catch {
    return true; // storage blocked — default behavior (same as missing key)
  }
}

// Lazy-useState-compatible reader for the mobile background-playback
// preference (Task 3 mobile-polish): missing key (first launch) defaults to
// ON — native audio keeps playing when the app is backgrounded (foreground
// service), the toggle OFF opt-in pauses on hidden. Same strict-'true' and
// blocked-storage contract as loadMinimizeToTrayState.
export function loadBackgroundPlaybackState(): boolean {
  try {
    const saved = localStorage.getItem(LS_BACKGROUND_PLAYBACK);
    return saved !== null ? saved === "true" : true;
  } catch {
    return true; // storage blocked — default behavior (same as missing key)
  }
}
