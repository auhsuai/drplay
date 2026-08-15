use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use tauri::Manager;

#[cfg(desktop)]
use std::sync::atomic::Ordering;

pub mod protocol;
mod thumbnail;
mod auth;
mod auth_android;
#[cfg(desktop)]
mod tray;
mod memory;
mod token_store;
mod seed;

use auth::{login_google_native, refresh_google_token};
use auth_android::login_google_mobile;
use memory::{apply_window_activity, WindowActivityEvent};
use protocol::cover::{clear_local_cache, clear_thumbnail_dir, get_cache_info};
#[cfg(desktop)]
use tray::{setup_tray, update_minimize_to_tray, IS_QUITTING, MINIMIZE_TO_TRAY};

pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

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
fn path_starts_with_ci(path: &Path, prefix: &Path) -> bool {
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
fn validate_path_for_scope(path: &str) -> Result<PathBuf, String> {
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

#[tauri::command]
fn register_download_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let canonical = validate_path_for_scope(&path)?;
    if !canonical.is_dir() {
        return Err(format!("cannot extend fs scope: download path must be a directory: \"{path}\""));
    }
    let scope = app.fs_scope();
    scope
        .allow_directory(path, true)
        .map_err(|e| format!("failed to extend fs scope for download dir: {e}"))?;
    Ok(())
}

// Extend the fs READ scope for the user-picked upload source (drag-drop or
// folder picker). Directories are allowed recursively so walkDiskFolder can
// descend; single files get a file pattern. The plugin's resolve_path checks
// `fs_scope.scope.is_allowed()` (runtime-extended scope) as an OR against the
// capability paths, so bare fs:allow-read-* capabilities + this extension are
// sufficient (verified against plugins-workspace v2 fs commands.rs 2026-08-02).
#[tauri::command]
fn register_upload_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    // Dir-vs-file is decided on the canonical path so a symlink to a directory
    // is registered recursively (the webview reads through the original link).
    let canonical = validate_path_for_scope(&path)?;
    let scope = app.fs_scope();
    if canonical.is_dir() {
        scope
            .allow_directory(path, true)
            .map_err(|e| format!("failed to extend fs scope for upload dir: {e}"))?;
    } else {
        scope
            .allow_file(path)
            .map_err(|e| format!("failed to extend fs scope for upload file: {e}"))?;
    }
    Ok(())
}

fn apply_window_activity_for_window(window: &tauri::Window, event: WindowActivityEvent) {
    if let Some(webview_window) = window.get_webview_window("main") {
        apply_window_activity(&webview_window, event);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = protocol::register(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_native_audio::init())
        // SAF download folder picker + writer — Android only (Task 4
        // mobile-polish; the Rust crate registers the Kotlin plugin, no
        // commands). Desktop init is a no-op.
        .plugin(tauri_plugin_saf_download::init());
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_keepawake::init());
    let app_result = builder
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).ok();

            // Single process-wide deep-link listener for the Android OAuth
            // flow (auth_android.rs); inert on desktop (no desktop schemes
            // configured). Must run after plugin setup — it does, setup
            // callbacks run after all plugins initialized.
            auth_android::init_deep_link_listener(app);

            if let Ok(cache_dir) = app.path().app_cache_dir() {
                let access_log = cache_dir.join(".thumbnails").join("access_log.json");
                crate::protocol::init_access_recorder(access_log);
                // S3: on-disk cover cache root + background GC thread (runs
                // once now, then every GC_INTERVAL_SECS; detached, never
                // blocks setup and dies with the process).
                let covers_root = cache_dir.join("covers");
                crate::protocol::cover::init_covers_root(covers_root.clone());
                crate::protocol::cover::spawn_covers_gc(covers_root);
                // Seed offline import: <app_cache_dir>/metadata holds the
                // imported metadata JSONs (read disk-first by the pipeline).
                crate::seed::init_metadata_root(cache_dir.join("metadata"));
            }

            #[cfg(desktop)]
            setup_tray(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            #[cfg(desktop)]
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !IS_QUITTING.load(std::sync::atomic::Ordering::SeqCst) && MINIMIZE_TO_TRAY.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = window.hide();
                    apply_window_activity_for_window(window, WindowActivityEvent::HiddenToTray);
                    api.prevent_close();
                }
            }
            tauri::WindowEvent::Focused(focused) => {
                let event = if *focused { WindowActivityEvent::Focused } else { WindowActivityEvent::Unfocused };
                apply_window_activity_for_window(window, event);
            }
            tauri::WindowEvent::Resized(size) => {
                let event = if size.width == 0 || size.height == 0 {
                    WindowActivityEvent::Minimized
                } else {
                    WindowActivityEvent::ResizedToNormal
                };
                apply_window_activity_for_window(window, event);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            login_google_native,
            login_google_mobile,
            refresh_google_token,
            register_download_path,
            register_upload_path,
            #[cfg(desktop)]
            update_minimize_to_tray,
            clear_local_cache,
            get_cache_info,
            clear_thumbnail_dir,
            seed::import_metadata_seed,
            seed::read_metadata_disk,
            token_store::set_refresh_token,
            token_store::get_refresh_token,
            token_store::delete_refresh_token,
        ])
        .build(tauri::generate_context!());

    let app = match app_result {
        Ok(app) => app,
        Err(e) => {
            eprintln!("[drplay] failed to build tauri application: {e}");
            std::process::exit(1);
        }
    };

    app.run(|_app_handle, event| match event {
            #[cfg(desktop)]
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                IS_QUITTING.store(true, Ordering::SeqCst);
            }
            _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_scope_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("drplay_scope_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
        dir
    }

    fn temp_scope_file(tag: &str) -> PathBuf {
        let file = temp_scope_dir(&format!("{}_file", tag)).join("probe.txt");
        std::fs::write(&file, b"probe").expect("test fixture file must be writable");
        file
    }

    #[test]
    fn validate_accepts_existing_dir() {
        let dir = temp_scope_dir("accept_dir");
        let canonical = validate_path_for_scope(dir.to_str().unwrap()).expect("existing dir must pass");
        assert!(canonical.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_accepts_existing_file() {
        let file = temp_scope_file("accept_file");
        let canonical = validate_path_for_scope(file.to_str().unwrap()).expect("existing file must pass");
        assert!(canonical.is_file());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn validate_rejects_nonexistent_path() {
        let missing = temp_scope_dir("missing").join("nope");
        assert!(validate_path_for_scope(missing.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(missing.parent().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn validate_rejects_drive_root() {
        let drive_root = format!(r"{}\", std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()));
        assert!(
            validate_path_for_scope(&drive_root).is_err(),
            "drive root {} must be rejected",
            drive_root
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn validate_rejects_fs_root() {
        assert!(validate_path_for_scope("/").is_err(), "filesystem root must be rejected");
    }

    #[cfg(windows)]
    #[test]
    fn validate_rejects_system_dir() {
        let windir = std::env::var("WINDIR").expect("WINDIR must be set on Windows");
        assert!(
            validate_path_for_scope(&windir).is_err(),
            "system dir {} must be rejected",
            windir
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn validate_rejects_system_dir() {
        assert!(validate_path_for_scope("/etc").is_err(), "/etc must be rejected");
    }

    #[test]
    fn validate_does_not_overblock_lookalike_dir() {
        let lookalike = temp_scope_dir("systemlike_safe");
        validate_path_for_scope(lookalike.to_str().unwrap()).expect("lookalike dir must pass");
        let _ = std::fs::remove_dir_all(&lookalike);
    }

    #[cfg(windows)]
    #[test]
    fn path_starts_with_ci_matches_prefix_case_insensitively() {
        assert!(path_starts_with_ci(Path::new(r"C:\Windows\System32"), Path::new(r"c:\windows")));
        assert!(path_starts_with_ci(Path::new(r"c:\windows"), Path::new(r"C:\WINDOWS")));
    }

    #[cfg(windows)]
    #[test]
    fn path_starts_with_ci_respects_component_boundary() {
        assert!(!path_starts_with_ci(Path::new(r"C:\WindowsSafe"), Path::new(r"C:\Windows")));
        assert!(!path_starts_with_ci(Path::new(r"C:\Windows"), Path::new(r"C:\WindowsSafe")));
    }

    #[cfg(not(windows))]
    #[test]
    fn path_starts_with_ci_matches_prefix() {
        assert!(path_starts_with_ci(Path::new("/etc/hosts"), Path::new("/etc")));
        assert!(!path_starts_with_ci(Path::new("/etcSafe"), Path::new("/etc")));
    }

    #[cfg(windows)]
    #[test]
    fn validate_rejects_symlink_to_system_dir() {
        let windir = std::env::var("WINDIR").expect("WINDIR must be set on Windows");
        let parent = temp_scope_dir("link_system");
        let link = parent.join("to_windows");
        match std::os::windows::fs::symlink_dir(&windir, &link) {
            Ok(()) => {
                assert!(
                    validate_path_for_scope(link.to_str().unwrap()).is_err(),
                    "symlink into a system dir must be rejected"
                );
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[cfg(not(windows))]
    #[test]
    fn validate_rejects_symlink_to_system_dir() {
        let parent = temp_scope_dir("link_system");
        let link = parent.join("to_etc");
        match std::os::unix::fs::symlink("/etc", &link) {
            Ok(()) => {
                assert!(
                    validate_path_for_scope(link.to_str().unwrap()).is_err(),
                    "symlink into a system dir must be rejected"
                );
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[cfg(windows)]
    #[test]
    fn validate_accepts_symlink_to_valid_dir() {
        let target = temp_scope_dir("link_target");
        let parent = temp_scope_dir("link_src");
        let link = parent.join("to_music");
        match std::os::windows::fs::symlink_dir(&target, &link) {
            Ok(()) => {
                validate_path_for_scope(link.to_str().unwrap())
                    .expect("symlink to a normal dir must pass");
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&parent);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[cfg(not(windows))]
    #[test]
    fn validate_accepts_symlink_to_valid_dir() {
        let target = temp_scope_dir("link_target");
        let parent = temp_scope_dir("link_src");
        let link = parent.join("to_music");
        match std::os::unix::fs::symlink(&target, &link) {
            Ok(()) => {
                validate_path_for_scope(link.to_str().unwrap())
                    .expect("symlink to a normal dir must pass");
            }
            Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
        }
        let _ = std::fs::remove_dir_all(&parent);
        let _ = std::fs::remove_dir_all(&target);
    }

    /// Guards against re-adding the SQLite backend after its removal
    /// (2026-08-03): the DB pool, migrations and 4 DB commands were deleted,
    /// so this crate must never pull in rusqlite/r2d2 again. Compiled in at
    /// build time via include_str! — a false positive is impossible.
    #[test]
    fn sqlite_backend_dependencies_are_absent() {
        let manifest = include_str!("../Cargo.toml");
        assert!(
            !manifest.contains("rusqlite"),
            "Cargo.toml must not depend on rusqlite — the SQLite backend was removed"
        );
        assert!(
            !manifest.contains("r2d2"),
            "Cargo.toml must not depend on r2d2 — the SQLite backend was removed"
        );
    }

    /// Guards against re-adding the R2 secret file after its removal
    /// (2026-08-03): r2_config.json held Cloudflare R2 credentials in
    /// plaintext and was deleted from disk. The R2 backend no longer exists
    /// in this codebase, so the file must never come back. Resolved via
    /// CARGO_MANIFEST_DIR so the check is independent of the test CWD.
    #[test]
    fn r2_secret_config_absent() {
        let secret_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("r2_config.json");
        assert!(
            !secret_path.exists(),
            "src-tauri/r2_config.json must not exist — R2 credentials were removed from disk"
        );
    }
}
