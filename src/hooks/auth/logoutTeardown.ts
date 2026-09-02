import { invoke } from "@tauri-apps/api/core";
import type { UserProfile } from "../../types";
import { invalidateCurrentSession } from "../../utils/sessionGuard";
import {
  revokeGoogleToken,
  stopProactiveRefresh,
  readRefreshToken,
  deleteRefreshToken,
} from "../../utils/apiClient";
import { stopProSyncWorker } from "../../utils/proSyncManager";
import {
  USER_EMAIL_KEY,
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_TIME_KEY,
  DEFAULT_USER_EMAIL,
  getCurrentUserEmail,
} from "../../utils/storageKeys";
import { CLEAR_LOCAL_CACHE_CMD } from "../../utils/cache";
import { wipePersistedMetadataCache } from "../../utils/metadata";
import { db } from "../../db/db";
import { wipeFileRowsForUser } from "../../db/fileRows";
import { captureError } from "../../utils/errorLog";
import { PLAYER_STOP_EVENT } from "../usePlayer";

const AUTH_MODULE = "useAuth";

// Dexie syncState key holding the Drive changes start-page token. Must stay
// byte-identical to START_PAGE_TOKEN_KEY in src/workers/syncRunner.ts (the
// worker module is deliberately NOT imported here — it would bundle the whole
// sync pipeline into the main thread just for one string constant).
const SYNC_START_PAGE_TOKEN_KEY = "startPageToken";

// Same shape as the sync worker's isValidSyncOwnerEmail: the shared sentinel
// ("default") identifies no real account, so there is nothing reliably owned
// to wipe for it — wiping the sentinel could destroy another account's
// legacy-migrated rows.
const isValidLogoutWipeEmail = (email: string): boolean =>
  email.trim().length > 0 && email !== DEFAULT_USER_EMAIL;

export const classifyError = (e: unknown): string =>
  e instanceof Error ? e.message : `[non-Error thrown] ${String(e)}`;

interface LogoutTeardownDeps {
  setIsLoggedIn: (isLoggedIn: boolean) => void;
  setAccessToken: (token: string | null) => void;
  setUserProfile: (profile: UserProfile | null) => void;
}

/**
 * Full logout teardown, extracted verbatim from useAuth's handleLogout body:
 * invalidate session, stop workers, clear storage, revoke both tokens, wipe
 * backend caches. The caller (useAuth) owns the concurrent-logout guard and
 * the finally-reset of that guard — a throw anywhere in here must still reset
 * it, and must still skip the caller's trailing onLogoutExt (same semantics
 * as when this block lived inside the try in handleLogout).
 */
export const runLogoutTeardown = async (deps: LogoutTeardownDeps) => {
  const { setIsLoggedIn, setAccessToken, setUserProfile } = deps;
  invalidateCurrentSession();
  stopProSyncWorker();

  // Read the long-lived refresh token BEFORE the localStorage clear
  // below: readRefreshToken falls back to the legacy LS copy when the
  // keyring read fails, so reading after the clear would silently skip
  // the revoke. A read failure (keyring + LS both unreachable) must not
  // block logout — log a warn and continue; deleteRefreshToken below
  // still wipes any keyring/LS residue.
  let refreshTokenToRevoke: string | null = null;
  try {
    refreshTokenToRevoke = await readRefreshToken();
  } catch (e: unknown) {
    void captureError({
      level: "warn",
      source: AUTH_MODULE,
      message: `Failed to read refresh token for revoke — continuing logout: ${classifyError(e)}`,
    });
  }

  // Account identity for the per-user DB wipe below must be captured
  // BEFORE the localStorage clear that follows (same reason
  // refreshTokenToRevoke is read first).
  const loggingOutEmail = getCurrentUserEmail();

  let tokenToRevoke: string | null = null;
  try {
    tokenToRevoke = localStorage.getItem(ACCESS_TOKEN_KEY);

    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(TOKEN_TIME_KEY);
    localStorage.removeItem(USER_EMAIL_KEY);
  } catch {
    void captureError({
      level: "warn",
      source: AUTH_MODULE,
      message: "auth-storage-clear-failed",
    });
  }
  setIsLoggedIn(false);
  setAccessToken(null);
  setUserProfile(null);
  stopProactiveRefresh();
  window.dispatchEvent(new CustomEvent(PLAYER_STOP_EVENT));

  try {
    // clear_stream_token was removed from the backend during the Service
    // Worker migration (commit a134f77) — only clear_local_cache remains.
    await invoke(CLEAR_LOCAL_CACHE_CMD);
  } catch (e: unknown) {
    void captureError({
      level: "warn",
      source: AUTH_MODULE,
      message: `Failed to clear backend cache (clear_local_cache) — continuing logout: ${classifyError(e)}`,
    });
  }

  // Account-boundary wipe: metadataCache IDB rows carry no userEmail, so
  // user A's cached title/artist/thumbnails must not survive logout for
  // user B. Fire-and-forget — IDB latency must not block logout; failures
  // are logged here and inside the wipe itself, never silent.
  void wipePersistedMetadataCache().catch((e: unknown) => {
    void captureError({
      level: "warn",
      source: AUTH_MODULE,
      message: `Metadata persisted-cache wipe failed — continuing logout: ${classifyError(e)}`,
    });
  });

  // Account-boundary wipe #2 (schema v10): db.files rows are keyed
  // [userEmail+id], so only the logged-out account's mirror is removed —
  // other accounts' rows survive. Skipped when no real email was ever
  // known (see isValidLogoutWipeEmail). Fire-and-forget exactly like the
  // metadata wipe above: IDB latency must not block logout; failures are
  // logged here and inside the wipe itself, never silent, and logout
  // never rejects because of it.
  if (isValidLogoutWipeEmail(loggingOutEmail)) {
    void wipeFileRowsForUser(loggingOutEmail).catch((e: unknown) => {
      void captureError({
        level: "warn",
        source: AUTH_MODULE,
        message: `Files persisted-wipe failed — continuing logout: ${classifyError(e)}`,
      });
    });
  }

  // Sync-cursor teardown: the Drive changes startPageToken in db.syncState
  // is account-scoped state — left behind, the NEXT login would delta-sync
  // the previous account's change window onto its own fresh mirror.
  // Deleted INDEPENDENTLY of the file wipe above (a failed wipe must not
  // preserve the stale cursor) and best-effort like every logout step:
  // failure logged, logout continues.
  void db.syncState.delete(SYNC_START_PAGE_TOKEN_KEY).catch((e: unknown) => {
    void captureError({
      level: "warn",
      source: AUTH_MODULE,
      message: `Failed to delete sync startPageToken — continuing logout: ${classifyError(e)}`,
    });
  });

  if (tokenToRevoke) {
    try {
      await revokeGoogleToken(tokenToRevoke);
    } catch (e: unknown) {
      void captureError({
        level: "warn",
        source: AUTH_MODULE,
        message: `Google token revoke failed — token may remain valid server-side: ${classifyError(e)}`,
      });
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
};
