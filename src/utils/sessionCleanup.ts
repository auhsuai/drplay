import { captureError } from "./errorLog";
import { SORT_OPTION_KEY } from "./storageKeys";
import { clearPlayerPersistence } from "./playerPersistence";

// Account-boundary logout wipe. The folder-view sort preference
// (drplay_sort_option, written by App.tsx) lives in localStorage next to the
// playback lanes; the playback lanes themselves (session localStorage, session
// kv, queue kv, playMode kv — scoped + legacy) are owned by
// playerPersistence.clearPlayerPersistence. Logout MUST clear both or a
// previous user's state resurrects in the next account.
export function clearSessionState(): void {
  try {
    localStorage.removeItem(SORT_OPTION_KEY);
  } catch (err) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "sessionCleanup",
      message: `localStorage cleanup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      kind: "localstorage-cleanup-failed",
    });
  }
  clearPlayerPersistence();
}
