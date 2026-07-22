import { invoke } from "@tauri-apps/api/core";

// Where the two Google OAuth tokens now live, and why (see AUDIT.md S1):
//
// - access_token: short-lived (~1h), kept in a plain in-memory module
//   variable. Never persisted anywhere -- not localStorage, not the OS
//   keychain. There's nothing gained by persisting it (a fresh
//   refresh-token exchange re-derives it in one round-trip on every app
//   start) and every extra place a live token is written at rest is one
//   more thing an attacker could read.
// - refresh_token: long-lived (valid indefinitely until revoked or unused
//   for ~6 months), stored via the Rust `store_token`/`get_token`/
//   `clear_token` commands, which delegate to the OS's own credential
//   store (Windows Credential Manager / macOS Keychain / Linux Secret
//   Service) through the `keyring` crate. This replaces the previous
//   plaintext `localStorage` storage for both tokens.

let accessToken: string | null = null;
let tokenIssuedAt = 0;

export function getAccessToken(): string | null {
  return accessToken;
}

/** Epoch ms the current access token was issued/refreshed at, or 0 if none. */
export function getTokenIssuedAt(): number {
  return tokenIssuedAt;
}

export function setAccessToken(token: string | null, issuedAt: number = Date.now()): void {
  accessToken = token;
  tokenIssuedAt = token ? issuedAt : 0;
}

const REFRESH_TOKEN_ACCOUNT = "refresh_token";

export async function storeRefreshToken(token: string): Promise<void> {
  await invoke("store_token", { account: REFRESH_TOKEN_ACCOUNT, value: token });
}

export async function getRefreshToken(): Promise<string | null> {
  try {
    return await invoke<string | null>("get_token", { account: REFRESH_TOKEN_ACCOUNT });
  } catch (e) {
    // No OS keychain available (e.g. headless Linux with no Secret Service
    // daemon running) or some other platform error -- treat as "not logged
    // in" rather than throwing, so callers fall back to the login screen
    // instead of crashing.
    console.warn("[tokenStore] get_token failed (treating as no stored refresh token)", e);
    return null;
  }
}

export async function clearRefreshToken(): Promise<void> {
  try {
    await invoke("clear_token", { account: REFRESH_TOKEN_ACCOUNT });
  } catch (e) {
    console.warn("[tokenStore] clear_token failed (non-blocking)", e);
  }
}
