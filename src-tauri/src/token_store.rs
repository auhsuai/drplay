// Secure storage for the Google OAuth refresh token.
//
// WHY this exists: the refresh token is a long-lived credential — anyone who
// holds it can mint new access tokens and take over the user's Google Drive
// account permanently. Google's OAuth best practices require storing it
// securely (https://developers.google.com/identity/protocols/oauth2/resources/best-practices),
// so it lives in the OS credential vault — Windows Credential Manager via the
// `keyring` crate (v1 feature auto-selects the platform store) — instead of
// plaintext WebView localStorage, which any XSS could exfiltrate.
//
// The short-lived access token (~1h expiry) intentionally stays in the
// frontend (localStorage): its exposure window is bounded, and keeping it
// client-side avoids a backend round-trip on every API call.
use keyring::Entry;

/// Service name under which the refresh token is stored in the OS keychain.
const SERVICE_NAME: &str = "drplay";
/// Entry key (username) under the service: the app uses a single Google
/// account at a time, so a fixed key is sufficient.
const REFRESH_TOKEN_USER: &str = "refresh_token";

fn refresh_token_entry() -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, REFRESH_TOKEN_USER).map_err(|e| {
        format!("failed to open OS credential vault entry (service \"{SERVICE_NAME}\"): {e}")
    })
}

/// Persist the Google OAuth refresh token in the OS credential vault.
#[tauri::command]
pub fn set_refresh_token(token: String) -> Result<(), String> {
    let entry = refresh_token_entry()?;
    entry.set_password(&token).map_err(|e| {
        // Never include the token in the error: it is a long-lived secret.
        format!("failed to store refresh token in the OS credential vault: {e}")
    })
}

/// Read the persisted refresh token, or `None` when nothing is stored.
#[tauri::command]
pub fn get_refresh_token() -> Result<Option<String>, String> {
    let entry = refresh_token_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        // No stored credential is the normal "signed out" state, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "failed to read refresh token from the OS credential vault: {e}"
        )),
    }
}

/// Delete the persisted refresh token; a missing entry is not an error.
#[tauri::command]
pub fn delete_refresh_token() -> Result<(), String> {
    let entry = refresh_token_entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a credential that is already gone is idempotent.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "failed to delete refresh token from the OS credential vault: {e}"
        )),
    }
}
