// Re-export from storageKeys (the SSOT for shared localStorage keys) under
// the historical LS_* names so existing callers keep compiling — a rename on
// either side is now a compile error instead of a silent split-brain.
export {
  ROOT_FOLDER_KEY as LS_ROOT_FOLDER,
  CURRENT_FOLDER_ID_KEY as LS_CURRENT_FOLDER_ID,
  CURRENT_FOLDER_NAME_KEY as LS_CURRENT_FOLDER_NAME,
  FOLDER_HISTORY_KEY as LS_FOLDER_HISTORY,
  SORT_OPTION_KEY as LS_SORT_OPTION,
  DB_NAV_STATE_KEY,
} from "./utils/storageKeys";

export const LS_MINIMIZE_TO_TRAY = "drplay_minimize_to_tray";

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
