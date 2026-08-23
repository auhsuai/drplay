import { captureError } from "./errorLog";

// Single source of truth for localStorage keys shared across modules.
export const USER_EMAIL_KEY = "drplay_current_user_email";
export const DEFAULT_USER_EMAIL = "default";
export const LANGUAGE_KEY = "drplay_language";
export const ROOT_FOLDER_KEY = "drplay_root_folder";
export const CURRENT_FOLDER_ID_KEY = "drplay_current_folder_id";
export const CURRENT_FOLDER_NAME_KEY = "drplay_current_folder_name";
export const FOLDER_HISTORY_KEY = "drplay_folder_history";
export const SORT_OPTION_KEY = "drplay_sort_option";
export const MINIMIZE_TO_TRAY_KEY = "drplay_minimize_to_tray";
export const BACKGROUND_PLAYBACK_KEY = "drplay_background_playback";
export const DB_NAV_STATE_KEY = "drplay_nav_state";
export const ACCESS_TOKEN_KEY = "drplay_access_token";
export const REFRESH_TOKEN_KEY = "drplay_refresh_token";
export const TOKEN_TIME_KEY = "drplay_token_time";

export function getCurrentUserEmail(): string {
  try {
    return localStorage.getItem(USER_EMAIL_KEY) || DEFAULT_USER_EMAIL;
  } catch {
    return DEFAULT_USER_EMAIL;
  }
}

// Error message contract: `<label>-failed:<err.name|unknown>`, level warn.
// Default source is "useDrive" — the useDriveInit call sites pin these exact
// strings. Other modules pass their own source as the last argument so the
// log attributes failures correctly instead of masquerading as useDrive.
function localStorageFailureMessage(label: string, err: unknown): string {
  return `${label}-failed:${
    err instanceof Error || err instanceof DOMException ? err.name : "unknown"
  }`;
}

export function safeLocalStorageGet(
  key: string,
  label: string,
  source: string = "useDrive",
): string | null {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    void captureError({
      level: "warn",
      source,
      message: localStorageFailureMessage(label, err),
    });
    return null;
  }
}

export function safeLocalStorageSet(
  key: string,
  value: string,
  label: string,
  source: string = "useDrive",
): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    void captureError({
      level: "warn",
      source,
      message: localStorageFailureMessage(label, err),
    });
  }
}
