import { invoke } from "@tauri-apps/api/core";

import { REFRESH_TOKEN_KEY } from "./storageKeys";
import { errMsg, warn, withTimeout } from "./apiClientShared";

// Keyring (OS credential vault) invokes can stall under lock-screen or DPAPI
// pressure; bound each one so a hung vault cannot block the refresh flow
// longer than this. Shorter than the refresh timeout because a vault hiccup
// is transient and readRefreshToken falls back to an in-memory copy.
const KEYRING_TIMEOUT_MS = 5000;

// Revoke (logout) is best-effort fire-and-forget: bound it so a stalled
// Google endpoint cannot delay the logout flow.
const REVOKE_TIMEOUT_MS = 5000;

// In-memory fallback for the refresh token when the keyring write fails.
// Google OAuth best-practice: refresh tokens live ONLY in secure storage —
// never localStorage — so on a vault failure the token survives for the
// current session in memory and an app restart drops it (the user must log in
// again, the correct degraded behavior; the failure is always logged).
let inMemoryRefreshToken: string | null = null;

/**
 * Read the long-lived refresh token. True precedence order:
 * 1. In-memory copy — when present it is ALWAYS the newest token: it is set
 *    only by a FAILED keyring write holding the rotated token, and cleared to
 *    null by every successful keyring write (see writeRefreshToken). A stale
 *    keyring value must therefore never win over a non-null memory value.
 * 2. OS credential vault (keyring) — the standing source of truth.
 * 3. One-time migration from a legacy localStorage copy (pre-keyring users:
 *    the token is moved into the keyring and localStorage is cleared
 *    immediately — it is never a standing fallback).
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
    await warn(
      `refresh-token-keyring-read-failed, using in-memory fallback: ${errMsg(err)}`,
    );
  }
  // One-time migration path: users who logged in before the keyring existed
  // still have their token here. Move it into secure storage and clear
  // localStorage right away; after this the token is never read from
  // localStorage again (our code no longer writes it there).
  let legacyToken: string | null = null;
  try {
    legacyToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch (err: unknown) {
    await warn(`refresh-token-localstorage-read-failed: ${errMsg(err)}`);
  }
  if (legacyToken) {
    await writeRefreshToken(legacyToken);
    return legacyToken;
  }
  return null;
};

/**
 * Persist the long-lived refresh token in the OS credential vault. Fire-and-
 * forget from the caller's perspective: it must not block the refresh flow
 * (the access token is already valid). The token is never written to
 * localStorage (Google OAuth best-practice: refresh tokens belong in secure
 * storage only); on a keyring failure it is kept in a module-level in-memory
 * variable for the current session — an app restart drops it and the user must
 * log in again, which is the correct degraded behavior (always logged). Never
 * rejects.
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
      await warn(
        `refresh-token-localstorage-clear-failed: ${errMsg(storageErr)}`,
      );
    }
    inMemoryRefreshToken = null;
  } catch (err: unknown) {
    await warn(
      `refresh-token-keyring-write-failed, keeping in-memory fallback: ${errMsg(err)}`,
    );
    // Never degrade to localStorage — keep the token in memory for this
    // session only. Best-effort clear of any legacy localStorage copy so a
    // refresh token can never live in localStorage.
    inMemoryRefreshToken = token;
    try {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch (storageErr: unknown) {
      await warn(
        `refresh-token-localstorage-clear-failed: ${errMsg(storageErr)}`,
      );
    }
  }
};

/**
 * Remove the long-lived refresh token from the OS credential vault. Called by
 * logout so a signed-out shared machine cannot leave the credential behind in
 * the keyring. Fire-and-forget and never rejects: the localStorage copy (legacy
 * migration residue) and the in-memory fallback are always cleared too, so the
 * token cannot survive in any store silently after a logout intent.
 */
export const deleteRefreshToken = async (): Promise<void> => {
  inMemoryRefreshToken = null;
  try {
    await withTimeout(invoke("delete_refresh_token"), KEYRING_TIMEOUT_MS);
  } catch (err: unknown) {
    // Never log the token; the Rust side strips it from its errors (see
    // token_store.rs). A vault failure must not block logout — the access
    // token is already gone, so the session ends regardless.
    await warn(`refresh-token-keyring-delete-failed: ${errMsg(err)}`);
  }
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // localStorage unavailable (privacy mode / quota): the keyring delete
    // already ran; there is no second store to clear. Never throw — the
    // caller is fire-and-forget.
    await warn("refresh-token-localstorage-clear-failed");
  }
};

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
      await warn(`refresh-token-revoke-failed: HTTP ${String(res.status)}`);
    }
  } catch (err: unknown) {
    await warn(`refresh-token-revoke-failed: ${errMsg(err)}`);
  }
}
