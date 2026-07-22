//! Structured error type for Tauri commands.
//!
//! Replaces bare `Result<T, String>` command signatures (acceptable for a
//! prototype, but AUDIT.md 5.2/7.1 flags it as dated for 2025-2026) with a
//! `thiserror`-backed enum that serializes as `{"kind": "<Variant>",
//! "message": "<text>"}` (serde adjacently tagged) instead of a flat string,
//! so the frontend can switch on `.kind` instead of pattern-matching on
//! message text.
//!
//! IMPORTANT, read before adding a new command or variant: a few existing
//! frontend call sites (`src/utils/apiClient.ts`'s `getValidToken`,
//! `src/ui/Login/LoginScreen.tsx`'s `handleLoginClick`) substring-match
//! specific message text (e.g. "invalid_grant", "timeout") from these exact
//! commands to decide *real* behavior (trigger logout, choose which toast to
//! show) -- not just for logging. This migration preserves every existing
//! message string byte-for-byte; only the envelope around them changed from
//! a bare string to `{kind, message}`. The frontend side was updated in the
//! same change (see `src/utils/appError.ts`'s `getErrorMessage`) to read
//! `.message` instead of blindly `String(err)`-ing the rejection, which
//! would otherwise stringify to the useless `"[object Object]"` once the
//! rejection became a structured object instead of a bare string. If you add
//! a new variant or reword a message that's substring-matched on the
//! frontend, grep both files above first.
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    /// Google OAuth2 login/token-refresh failures (commands/auth.rs).
    #[error("{0}")]
    Auth(String),
    /// OS keychain (keyring crate) read/write/delete failures
    /// (commands/token_store.rs).
    #[error("{0}")]
    Keychain(String),
    /// Filesystem / fs-scope / download I/O failures.
    #[error("{0}")]
    Io(String),
    /// A `spawn_blocking`/`spawn` task panicked (tokio `JoinError`) --
    /// distinct from a normal in-band failure, since it means a Rust bug
    /// crashed the task rather than an expected error condition.
    #[error("{0}")]
    TaskPanicked(String),
    /// Catch-all for anything that doesn't fit the above.
    #[error("{0}")]
    Other(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_tagged_kind_message_object() {
        let e = AppError::Auth("Failed to refresh token: invalid_grant".to_string());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"Auth","message":"Failed to refresh token: invalid_grant"}"#
        );
    }

    #[test]
    fn display_matches_the_raw_message() {
        // Rust call sites doing `.to_string()` / `{e}` on an AppError (e.g. a
        // log::error! call) must still see the exact underlying text, not a
        // Debug-ish "Auth(\"...\")" wrapper.
        let e = AppError::Io("permission denied".to_string());
        assert_eq!(e.to_string(), "permission denied");
    }

    #[test]
    fn every_variant_round_trips_kind_correctly() {
        let cases = [
            (AppError::Auth("a".into()), "Auth"),
            (AppError::Keychain("k".into()), "Keychain"),
            (AppError::Io("i".into()), "Io"),
            (AppError::TaskPanicked("t".into()), "TaskPanicked"),
            (AppError::Other("o".into()), "Other"),
        ];
        for (err, expected_kind) in cases {
            let json = serde_json::to_string(&err).unwrap();
            assert!(
                json.starts_with(&format!(r#"{{"kind":"{expected_kind}""#)),
                "expected kind {expected_kind} in {json}"
            );
        }
    }
}
