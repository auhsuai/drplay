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
