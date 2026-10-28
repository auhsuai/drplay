import { invoke } from "@tauri-apps/api/core";
import { db } from "../../db/db";
import { wipeFileRowsForUser } from "../../db/fileRows";
import { CLEAR_LOCAL_CACHE_CMD } from "../../utils/cache";
import {
  deleteRefreshToken,
  readRefreshToken,
  revokeGoogleToken,
  stopProactiveRefresh,
} from "../../utils/apiClient";
import {
  clearAllMetadataCache,
  wipePersistedMetadataCache,
} from "../../utils/metadata";
import { invalidateCurrentSession } from "../../utils/sessionGuard";
import { stopProSyncWorker } from "../../utils/proSyncManager";
import {
  ACCESS_TOKEN_KEY,
  DEFAULT_USER_EMAIL,
  REFRESH_TOKEN_KEY,
  TOKEN_TIME_KEY,
  USER_EMAIL_KEY,
  getCurrentUserEmail,
} from "../../utils/storageKeys";
import { PLAYER_STOP_EVENT } from "../usePlayer";
import { classifyError } from "../useDriveShared";
import { logAuth } from "./authLog";

// Dexie syncState key holding the Drive changes start-page token. Must stay
// byte-identical to START_PAGE_TOKEN_KEY in src/workers/syncState.ts (the
// worker module is deliberately NOT imported here — it would bundle the whole
// sync pipeline into the main thread just for one string constant).
export const SYNC_START_PAGE_TOKEN_KEY = "startPageToken";

// Same shape as the sync worker's isValidSyncOwnerEmail: the shared sentinel
// ("default") identifies no real account, so there is nothing reliably owned
// to wipe for it — wiping the sentinel could destroy another account's
// legacy-migrated rows.
const isValidLogoutWipeEmail = (email: string): boolean =>
  email.trim().length > 0 && email !== DEFAULT_USER_EMAIL;

export interface LogoutCleanupDeps {
  /**
   * Clears the logged-in state in ONE closure so the service keeps the exact
   * historical position and setter order:
   * setIsLoggedIn(false) -> setAccessToken(null) -> setUserProfile(null).
   * Called exactly once, right after the localStorage clear.
   */
  clearLoginState: () => void;
  /**
   * Reads onLogoutExtRef.current at CALL TIME (never captures the value): the
   * caller keeps a stable handleLogout while the callback identity stays fresh.
   */
  getOnLogoutExt: () => (() => void) | undefined;
}

/**
 * Runs the whole logout teardown, in the historical order (0 -> 17).
 *
 * - Steps 1..15 (invalidate, stop workers, read refresh token, clear LS,
 *   clear login state, backend/metadata/file/cursor wipes, revoke access then
 *   refresh, delete keyring) run here.
 * - USER_EMAIL_KEY is already gone by then, so any email-scoped cleanup in the
 *   caller's `onLogoutExt` must rely on a previously captured key.
 * - The caller's callback runs LAST (step 16); the guard reset in the hook's
 *   `finally` is step 17.
 *
 * Never throws: every step is either guarded by its own try/catch or backed by
 * a non-rejecting helper (revokeGoogleToken / deleteRefreshToken).
 */
export async function runLogoutCleanup(deps: LogoutCleanupDeps): Promise<void> {
  invalidateCurrentSession();
  stopProSyncWorker();

  // Account identity for the per-user DB wipe below must be captured BEFORE
  // the localStorage clear that follows (same reason refreshTokenToRevoke is
  // read first).
  const loggingOutEmail = getCurrentUserEmail();

  // Read the long-lived refresh token BEFORE the localStorage clear below:
  // readRefreshToken falls back to the legacy LS copy when the keyring read
  // fails, so reading after the clear would silently skip the revoke. A read
  // failure (keyring + LS both unreachable) must not block logout — log a warn
  // and continue; deleteRefreshToken below still wipes any keyring/LS residue.
  let refreshTokenToRevoke: string | null = null;
  try {
    refreshTokenToRevoke = await readRefreshToken();
  } catch (e: unknown) {
    void logAuth(
      "warn",
      `Failed to read refresh token for revoke — continuing logout: ${classifyError(e)}`,
    );
  }

  let tokenToRevoke: string | null = null;
  try {
    tokenToRevoke = localStorage.getItem(ACCESS_TOKEN_KEY);

    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(TOKEN_TIME_KEY);
    localStorage.removeItem(USER_EMAIL_KEY);
  } catch {
    void logAuth("warn", "auth-storage-clear-failed");
  }
  deps.clearLoginState();
  stopProactiveRefresh();
  window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));

  try {
    // clear_stream_token was removed from the backend during the Service
    // Worker migration (commit a134f77) — only clear_local_cache remains.
    await invoke(CLEAR_LOCAL_CACHE_CMD);
    clearAllMetadataCache();
  } catch (e: unknown) {
    void logAuth(
      "warn",
      `Failed to clear backend cache (clear_local_cache) — continuing logout: ${classifyError(e)}`,
    );
  }

  // Account-boundary wipe: metadataCache IDB rows carry no userEmail, so
  // user A's cached title/artist/thumbnails must not survive logout for
  // user B. Fire-and-forget — IDB latency must not block logout; failures
  // are logged here and inside the wipe itself, never silent.
  void wipePersistedMetadataCache().catch((e: unknown) => {
    void logAuth(
      "warn",
      `Metadata persisted-cache wipe failed — continuing logout: ${classifyError(e)}`,
    );
  });

  // Account-boundary wipe #2 (schema v10): db.files rows are keyed
  // [userEmail+id], so only the logged-out account's mirror is removed —
  // other accounts' rows survive. Skipped when no real email was ever known
  // (see isValidLogoutWipeEmail). Fire-and-forget exactly like the metadata
  // wipe above: IDB latency must not block logout; failures are logged here
  // and inside the wipe itself, never silent, and logout never rejects
  // because of it.
  if (isValidLogoutWipeEmail(loggingOutEmail)) {
    void wipeFileRowsForUser(loggingOutEmail).catch((e: unknown) => {
      void logAuth(
        "warn",
        `Files persisted-wipe failed — continuing logout: ${classifyError(e)}`,
      );
    });
  }

  // Sync-cursor teardown: the Drive changes startPageToken in db.syncState
  // is account-scoped state — left behind, the NEXT login would delta-sync
  // the previous account's change window onto its own fresh mirror.
  // Deleted INDEPENDENTLY of the file wipe above (a failed wipe must not
  // preserve the stale cursor) and best-effort like every logout step:
  // failure logged, logout continues.
  void db.syncState.delete(SYNC_START_PAGE_TOKEN_KEY).catch((e: unknown) => {
    void logAuth(
      "warn",
      `Failed to delete sync startPageToken — continuing logout: ${classifyError(e)}`,
    );
  });

  if (tokenToRevoke) {
    try {
      await revokeGoogleToken(tokenToRevoke);
    } catch (e: unknown) {
      void logAuth(
        "warn",
        `Google token revoke failed — token may remain valid server-side: ${classifyError(e)}`,
      );
    }
  }

  // Revoke the long-lived refresh token too: the Google revoke endpoint
  // accepts refresh tokens as well as access tokens, so a leaked refresh
  // credential cannot stay valid after logout. revokeGoogleToken never
  // throws (non-blocking, logs internally), so no local try/catch needed.
  if (refreshTokenToRevoke) {
    await revokeGoogleToken(refreshTokenToRevoke);
  }

  // Remove the long-lived refresh token from the OS credential vault
  // (keyring) — the LS copy is already cleared above. Fire-and-forget:
  // deleteRefreshToken never rejects, so a vault hiccup cannot break
  // logout (shared-machine safety: no credential residue).
  void deleteRefreshToken();

  deps.getOnLogoutExt()?.();
}
