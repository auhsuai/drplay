import { safeLocalStorageGet, safeLocalStorageSet } from "../storageKeys";

const STORAGE_KEY = "drplay_metadata_fetch_enabled";

// Reader mirrors loadMinimizeToTrayState (appUiState): missing/blocked key
// (first launch) defaults to fetching ENABLED; only the literal 'true' means
// enabled, any other stored value ('false'/corrupt) means disabled. The read
// goes through safeLocalStorageGet (SSOT, same pattern as sidebarState): a
// blocked storage (SecurityError) is LOGGED instead of swallowed and returns
// null, which falls back to the first-launch default exactly like a missing
// key.
export function isMetadataFetchEnabled(): boolean {
  const saved = safeLocalStorageGet(
    STORAGE_KEY,
    "metadata-fetch-read",
    "metadataSettings",
  );
  return saved === null ? true : saved === "true";
}

export function setMetadataFetchEnabled(enabled: boolean): void {
  safeLocalStorageSet(
    STORAGE_KEY,
    String(enabled),
    "metadata-fetch-write",
    "metadataSettings",
  );
}
