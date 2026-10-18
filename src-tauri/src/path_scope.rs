//! Frontend-supplied path validation before the webview fs scope is widened.

use std::path::{Component, Path, PathBuf};

// Directories that must never be opened to the webview fs scope, even when the
// user (or an XSS payload) picks them: granting read access to e.g. C:\Windows
// or /etc would let the webview read system files, not just the user's music.
const BLOCKED_UNIX_SCOPE_DIRS: &[&str] = &[
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/proc", "/sys", "/dev",
    "/boot", "/var", "/System", "/Library",
];

// Windows system dirs are looked up from their env vars so the list survives
// non-default install locations; ProgramW6432 covers 32-bit processes on
// 64-bit Windows where ProgramFiles points at "(x86)".
const BLOCKED_WINDOWS_SCOPE_ENV_VARS: &[&str] = &[
    "WINDIR",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "ProgramData",
];

// Case-insensitive prefix test on Windows (Path::starts_with is case-sensitive
// there). Component-wise comparison keeps the boundary exact: "C:\Windows"
// must never match "C:\WindowsSafe".
pub(super) fn path_starts_with_ci(path: &Path, prefix: &Path) -> bool {
    let path_components: Vec<Component> = path.components().collect();
    let prefix_components: Vec<Component> = prefix.components().collect();
    if path_components.len() < prefix_components.len() {
        return false;
    }
    path_components
        .iter()
        .zip(prefix_components.iter())
        .all(|(a, b)| {
            if cfg!(windows) {
                a.as_os_str().to_string_lossy().to_lowercase()
                    == b.as_os_str().to_string_lossy().to_lowercase()
            } else {
                a == b
            }
        })
}

// Each blocked dir plus its canonical form: on macOS /etc is a symlink to
// /private/etc, so a canonicalized user path must be compared against BOTH
// spellings to be caught.
fn with_canonical_variant(path: PathBuf) -> Vec<PathBuf> {
    let mut variants = vec![path.clone()];
    if let Ok(canonical) = std::fs::canonicalize(&path) {
        variants.push(canonical);
    }
    variants
}

fn blocked_scope_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        BLOCKED_WINDOWS_SCOPE_ENV_VARS
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .map(PathBuf::from)
            .flat_map(with_canonical_variant)
            .collect()
    } else {
        BLOCKED_UNIX_SCOPE_DIRS
            .iter()
            .map(PathBuf::from)
            .flat_map(with_canonical_variant)
            .collect()
    }
}

// Validate a frontend-supplied path before extending the fs scope, so an XSS
// cannot widen the read scope to anywhere on disk (root, system dirs, or a
// symlink resolving into them). canonicalize() folds in the existence check
// (it errors on missing paths) and resolves symlinks; the caller still
// registers the ORIGINAL string, because tauri-plugin-fs v2 resolve_path
// checks scope membership against the literal path the webview passes
// (commands.rs:1567 is_allowed(&resolved_path), plugin 2.5.1).
pub(super) fn validate_path_for_scope(path: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("cannot extend fs scope: \"{path}\" does not exist or is not accessible: {e}"))?;
    if !canonical.is_dir() && !canonical.is_file() {
        return Err(format!("cannot extend fs scope: \"{path}\" is neither a file nor a directory"));
    }
    // A parentless canonical path is a filesystem root: C:\, D:\, / or a UNC
    // share root. Any of those would hand the webview the whole tree.
    if canonical.parent().is_none() {
        return Err(format!("cannot extend fs scope: filesystem root is not allowed: \"{path}\""));
    }
    for blocked in blocked_scope_dirs() {
        if path_starts_with_ci(&canonical, &blocked) {
            return Err(format!("cannot extend fs scope: system directory not allowed: \"{path}\""));
        }
    }
    Ok(canonical)
}
