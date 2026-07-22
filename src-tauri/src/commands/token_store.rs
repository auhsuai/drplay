//! Secure OS-keychain-backed storage for long-lived OAuth credentials.
//!
//! Replaces storing the Google refresh token in the frontend's `localStorage`
//! (plaintext, unencrypted-at-rest, readable by any process running as the
//! same OS user) with the `keyring` crate, which delegates to the OS's own
//! credential store: Windows Credential Manager, macOS Keychain, or the
//! Linux Secret Service (GNOME Keyring / KWallet via D-Bus).
//!
//! The access token deliberately does NOT go through here -- it is short-
//! lived (~1h) and kept in-memory only on the frontend side (see
//! `src/utils/tokenStore.ts`), so there's no round-trip IPC cost on every
//! check and nothing meaningful is lost by not persisting it at all across a
//! restart (a fresh refresh-token exchange re-establishes it immediately).
use tauri::command;

use crate::AppError;

/// Keychain "service" namespace. Paired with an `account` string
/// (currently only "refresh_token") to form the OS credential's identity.
const SERVICE_NAME: &str = "drplay";

#[command]
pub async fn store_token(account: String, value: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE_NAME, &account).map_err(|e| AppError::Keychain(e.to_string()))?;
        entry.set_password(&value).map_err(|e| AppError::Keychain(e.to_string()))
    })
    .await
    .map_err(|e| AppError::TaskPanicked(format!("Task panicked: {e}")))?
}

#[command]
pub async fn get_token(account: String) -> Result<Option<String>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE_NAME, &account).map_err(|e| AppError::Keychain(e.to_string()))?;
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keychain(e.to_string())),
        }
    })
    .await
    .map_err(|e| AppError::TaskPanicked(format!("Task panicked: {e}")))?
}

#[command]
pub async fn clear_token(account: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE_NAME, &account).map_err(|e| AppError::Keychain(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Already absent -- logout/clear should be idempotent, not an error.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keychain(e.to_string())),
        }
    })
    .await
    .map_err(|e| AppError::TaskPanicked(format!("Task panicked: {e}")))?
}
