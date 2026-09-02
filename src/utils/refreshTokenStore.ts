import { invoke } from "@tauri-apps/api/core";

import { captureError } from "./errorLog";
import { REFRESH_TOKEN_KEY } from "./storageKeys";
import { withTimeout } from "./apiClientShared";

// Tauri v2 invoke does not accept an AbortSignal (tauri issue #8351 is still
// open), so the refresh_google_token call must be bounded by a timeout
// wrapper — a stalled Rust backend could otherwise hang getValidToken forever.
export const REFRESH_TIMEOUT_MS = 15_000;

// Keyring (OS credential vault) invokes can stall under lock-screen or DPAPI
// pressure; bound each one so a hung vault cannot block the refresh flow
// longer than this. Shorter than REFRESH_TIMEOUT_MS because a vault hiccup is
// transient and readRefreshToken has a localStorage fallback anyway.
const KEYRING_TIMEOUT_MS = 5000;

// Revoke (logout) is best-effort fire-and-forget: bound it so a stalled
// Google endpoint cannot delay the logout flow.
const REVOKE_TIMEOUT_MS = 5000;

/**
 * Best-effort server-side revocation of a Google OAuth token at logout. The
 * Google revoke endpoint accepts both access and refresh tokens, so a leaked
 * credential cannot stay valid after a sign-out on a shared machine. Never
 * throws: a network failure is logged (warn) and ignored — logout must not be
 * blocked by a dead connection.
 * @param token The access or refresh token to revoke (empty/absent → no-op).
 * @returns Resolves when the revoke attempt finished (success or logged failure).
 */
export async function revokeGoogleToken(token: string): Promise<void> {
  if (!token) return;
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}`,
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-revoke-failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Read the long-lived refresh token from the OS credential vault (keyring).
 * The keyring is the source of truth; localStorage only holds a legacy copy
 * from before the keyring migration. Fallback order: keyring → localStorage →
 * null. A keyring failure is non-fatal (warn + fallback), so a vault hiccup
 * can never sign the user out.
 * @returns The refresh token, or null when neither store has one.
 */
export const readRefreshToken = async (): Promise<string | null> => {
  try {
    const keyringToken = await withTimeout(
      invoke<string | null>("get_refresh_token"),
      KEYRING_TIMEOUT_MS,
    );
    if (typeof keyringToken === "string" && keyringToken.length > 0) {
      return keyringToken;
    }
  } catch (err: unknown) {
    // Never log the token; the Rust side already strips it from its errors
    // (see token_store.rs).
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-keyring-read-failed, falling back to localStorage: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  // Migration path: users who logged in before the keyring existed still have
  // their token here; the next successful write migrates it to the keyring
  // and removes this copy (see writeRefreshToken).
  return localStorage.getItem(REFRESH_TOKEN_KEY);
};

/**
 * Persist the long-lived refresh token in the OS credential vault. Fire-and-
 * forget from the caller's perspective: it must not block the refresh flow
 * (the access token is already valid). On failure the token is kept in
 * localStorage (degraded mode, always logged) so it is never lost silently —
 * the next rotation retries the keyring write. Never rejects.
 * @param token The refresh token to persist.
 */
export const writeRefreshToken = async (token: string): Promise<void> => {
  try {
    await withTimeout(
      invoke("set_refresh_token", { token }),
      KEYRING_TIMEOUT_MS,
    );
    // Success: the keyring is now the single source of truth — drop the
    // legacy localStorage copy so the credential never exists in two places.
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch (err: unknown) {
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-keyring-write-failed, keeping localStorage fallback: ${err instanceof Error ? err.message : String(err)}`,
    });
    try {
      localStorage.setItem(REFRESH_TOKEN_KEY, token);
    } catch (storageErr: unknown) {
      // localStorage unavailable (quota/private mode): nothing left to do —
      // log, never throw (the caller is fire-and-forget and the access token
      // is still usable for its ~1h lifetime).
      await captureError({
        level: "warn",
        source: "apiClient",
        message: `refresh-token-localstorage-write-failed: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`,
      });
    }
  }
};

/**
 * Remove the long-lived refresh token from the OS credential vault. Called by
 * logout so a signed-out shared machine cannot leave the credential behind in
 * the keyring. Fire-and-forget and never rejects: the localStorage copy is
 * always cleared too, so the token cannot survive in either store silently
 * after a logout intent.
 */
export const deleteRefreshToken = async (): Promise<void> => {
  try {
    await withTimeout(invoke("delete_refresh_token"), KEYRING_TIMEOUT_MS);
  } catch (err: unknown) {
    // Never log the token; the Rust side strips it from its errors (see
    // token_store.rs). A vault failure must not block logout — the access
    // token is already gone, so the session ends regardless.
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-keyring-delete-failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // localStorage unavailable (privacy mode / quota): the keyring delete
    // already ran; there is no second store to clear. Never throw — the
    // caller is fire-and-forget.
    await captureError({
      level: "warn",
      source: "apiClient",
      message: "refresh-token-localstorage-clear-failed",
    });
  }
};
