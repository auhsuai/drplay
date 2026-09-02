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

// In-memory copy of the NEWEST refresh token, set ONLY when a keyring write
// failed while holding the rotated token (durable fallback: localStorage) and
// cleared to null by every successful keyring write. Because it is always
// newer than whatever the vault still holds, readRefreshToken serves it
// before ever consulting the keyring — a stale vault value must never win.
let inMemoryRefreshToken: string | null = null;

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
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}`,
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Best-effort revoke: a rejected status is logged with the HTTP status
      // code only — never the token or the response body — and logout
      // proceeds regardless.
      await captureError({
        level: "warn",
        source: "apiClient",
        message: `refresh-token-revoke-failed: HTTP ${String(res.status)}`,
      });
    }
  } catch (err: unknown) {
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-revoke-failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Read the long-lived refresh token. True precedence order:
 * 1. In-memory copy — when present it is ALWAYS the newest token: it is set
 *    only by a FAILED keyring write holding the rotated token, and cleared to
 *    null by every successful keyring write (see writeRefreshToken). A stale
 *    keyring value must therefore never win over a non-null memory value.
 * 2. OS credential vault (keyring) — the standing source of truth.
 * 3. Legacy localStorage copy (degraded fallback after keyring failures).
 * A keyring failure is non-fatal (warn + fallback), so a vault hiccup can
 * never sign the user out.
 * @returns The refresh token, or null when no store has one.
 */
export const readRefreshToken = async (): Promise<string | null> => {
  // Memory-first: a non-null inMemoryRefreshToken means the last keyring
  // write failed while holding the NEWEST token, so whatever the vault still
  // holds is older. Skip the vault read entirely and serve memory. Snapshot
  // into a local so the async body below cannot observe a torn mid-flight
  // rotation write.
  const memoryToken: string | null = inMemoryRefreshToken;
  if (memoryToken !== null) {
    return memoryToken;
  }
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
    // Success: the keyring is now the single source of truth — drop any
    // legacy localStorage copy and stale in-memory fallback so the credential
    // never exists in two places. The clear is wrapped separately: a
    // localStorage failure here must NOT escape into the keyring-failure
    // catch below (the vault write already succeeded) nor skip the
    // in-memory cleanup.
    try {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch (storageErr: unknown) {
      await captureError({
        level: "warn",
        source: "apiClient",
        message: `refresh-token-localstorage-clear-failed: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`,
      });
    }
    inMemoryRefreshToken = null;
  } catch (err: unknown) {
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-keyring-write-failed, keeping localStorage fallback: ${err instanceof Error ? err.message : String(err)}`,
    });
    // The rotated token is the NEWEST credential and the vault still holds an
    // older one — keep it in memory so every read prefers it over the stale
    // keyring value (see readRefreshToken), alongside the durable localStorage
    // fallback below.
    inMemoryRefreshToken = token;
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
  // Purge the in-memory copy too: after a logout intent the token must not
  // survive in any store readRefreshToken consults, memory included.
  inMemoryRefreshToken = null;
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
