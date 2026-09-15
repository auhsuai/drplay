import { safeLocalStorageGet, safeLocalStorageSet } from "./utils/storageKeys";

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
// The read goes through safeLocalStorageGet (SSOT, same pattern as
// sidebarState): a blocked storage (SecurityError — see MDN Window.localStorage)
// is LOGGED instead of swallowed, and returns null, which falls back to the
// first-launch default exactly like a missing key.
export function loadMinimizeToTrayState(): boolean {
  const saved = safeLocalStorageGet(
    LS_MINIMIZE_TO_TRAY,
    "minimize-to-tray-read",
    "appUiState",
  );
  return saved === null ? true : saved === "true";
}

export function saveMinimizeToTrayState(minimize: boolean): void {
  safeLocalStorageSet(
    LS_MINIMIZE_TO_TRAY,
    String(minimize),
    "tray-write",
    "appUiState",
  );
}
