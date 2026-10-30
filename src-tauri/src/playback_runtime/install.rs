//! Install pipeline: download -> verify -> extract -> validate -> publish.
//!
//! ## Layout
//!
//! ```text
//! <app_local_data_dir>/engines/
//!   .staging/<uuid>/            in-flight work, deleted on every exit path
//!   mpv/<version>/mpv.exe       the published engine
//!   mpv/<other-version>/mpv.exe a previously working install (never touched)
//! ```
//!
//! ## Invariants
//!
//! * **One install at a time.** A process-wide flag, taken with
//!   `compare_exchange` and released by a `Drop` guard, so a panic cannot wedge
//!   every future attempt.
//! * **Nothing is published before it is fully validated.** Size floor plus a
//!   readable Windows version resource, both checked on the staging copy.
//! * **An existing working install is never destroyed.** Publishing only ever
//!   targets the version directory it just validated, and a failure anywhere
//!   leaves every other version directory untouched.
//! * **Staging never leaks.** Every exit path -- success, error, panic -- removes
//!   the staging directory.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::download::{receive_asset, AssetTransport, ExpectedAsset};
use super::error::FallbackError;
use super::extract::{extract_engine_exe, ExtractLimits};
use super::metadata;
use super::status::{engine_exe_path, staging_root, FallbackProgress, FallbackStatus};
use super::win_version;

/// One install at a time, process-wide.
static INSTALL_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Releases [`INSTALL_IN_PROGRESS`] on drop, including on panic.
pub(crate) struct InstallSlotGuard;

impl Drop for InstallSlotGuard {
    fn drop(&mut self) {
        INSTALL_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// Takes the single-install slot, or `None` when it is already held.
pub(crate) fn try_acquire_install_slot() -> Option<InstallSlotGuard> {
    INSTALL_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| InstallSlotGuard)
}

/// Removes the staging directory when dropped: the "never leak" invariant.
struct StagingDirGuard {
    path: PathBuf,
}

impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        if self.path.exists() {
            if let Err(err) = std::fs::remove_dir_all(&self.path) {
                log::warn!(
                    "[playback_runtime] could not remove staging dir {}: {err}",
                    self.path.display()
                );
            }
        }
    }
}

/// Install options: the expected asset digest/size and the size window.
///
/// Production MUST use [`InstallOptions::pinned`]. The fields exist so tests can
/// drive the whole pipeline with a small synthetic archive; they are NOT a
/// policy seam and must never be exposed to the frontend. Loosening `expected`
/// would bypass the integrity check, and loosening `limits` would accept a stub
/// binary.
#[derive(Debug, Clone, Copy)]
pub struct InstallOptions {
    pub expected: ExpectedAsset,
    pub limits: ExtractLimits,
}

impl InstallOptions {
    pub const fn pinned() -> Self {
        Self { expected: ExpectedAsset::pinned(), limits: ExtractLimits::pinned() }
    }
}

/// Installs the fallback engine for `app`, reporting progress through
/// `on_progress`.
///
/// Slice 3 wires the callback to a Tauri event; this function deliberately does
/// not know about events.
pub async fn install_fallback(
    app: &tauri::AppHandle,
    on_progress: &mut dyn FnMut(FallbackProgress),
) -> Result<FallbackStatus, FallbackError> {
    use tauri::Manager;

    // Fail loud: without a local data dir there is nowhere to install, and
    // silently picking another location would put the engine outside the
    // uninstaller's reach.
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|err| {
            log::error!("[playback_runtime] app_local_data_dir unavailable: {err}");
            FallbackError::PathUnavailable
        })?;

    let transport = super::download::HttpTransport::new()?;

    // The pinned asset is a Windows x86_64 build. On any other target the
    // download would succeed and then the binary could never run, so fail
    // before touching the network.
    if std::env::consts::ARCH != "x86_64" {
        return Err(FallbackError::UnsupportedPlatform);
    }

    install_into(&local_data, &transport, InstallOptions::pinned(), on_progress).await
}

/// Core install, driven by an explicit root and transport so it is testable
/// without a Tauri `AppHandle` and without real network access.
pub async fn install_into(
    local_data_root: &Path,
    transport: &dyn AssetTransport,
    options: InstallOptions,
    on_progress: &mut dyn FnMut(FallbackProgress),
) -> Result<FallbackStatus, FallbackError> {
    let _slot = try_acquire_install_slot().ok_or(FallbackError::AlreadyInProgress)?;

    let version = metadata::MPV_VERSION;
    let target = engine_exe_path(local_data_root, version);

    // Idempotent success: a valid install is kept as-is, no download at all.
    if let FallbackStatus::Installed { .. } = evaluate_exe_with_limits(&target, options.limits) {
        return Ok(evaluate_exe_with_limits(&target, options.limits));
    }

    // Leftovers from a killed process are dead weight; clear them before adding
    // our own.
    cleanup_stale_staging(local_data_root);

    let staging = staging_root(local_data_root).join(new_staging_name());
    std::fs::create_dir_all(&staging)
        .map_err(|err| FallbackError::PublishFailed { detail: describe_io("create the staging folder", &err) })?;
    let _staging_guard = StagingDirGuard { path: staging.clone() };

    // 1. Download + verify (length, then SHA-256).
    let fetched = transport.fetch(&metadata::download_url()).await?;
    let archive = receive_asset(fetched, &staging, options.expected, on_progress).await?;

    // 2. Extract the single pinned entry.
    on_progress(FallbackProgress::Extracting);
    let extracted = extract_engine_exe(&archive, &staging, options.limits)?;

    // 3. Validate the staged binary BEFORE it can be seen as installed.
    let probed = validate_candidate(&extracted.path, extracted.size, options.limits)?;

    // 4. Publish: temp name inside the version dir, then a single rename.
    on_progress(FallbackProgress::Publishing);
    publish(&extracted.path, &target)?;

    // 5. Mark-of-the-Web: the browser-style ADS that SmartScreen and some AV
    //    scanners attach to files that arrived over the network. It is stripped
    //    only AFTER the binary has been hashed, validated and published -- never
    //    before, so nothing can act on an "unmarked" file mid-pipeline.
    //    Best-effort: a failure is logged, not fatal, because the ADS is a
    //    heuristic and the binary itself is already verified.
    strip_zone_identifier(&target);

    Ok(FallbackStatus::Installed {
        version: probed.clone(),
        path: target.to_string_lossy().into_owned(),
        size: extracted.size,
    })
}

/// Result of a successful validation of a candidate binary.
fn validate_candidate(
    path: &Path,
    size: u64,
    limits: ExtractLimits,
) -> Result<String, FallbackError> {
    if size < limits.floor {
        return Err(FallbackError::ExeTooSmall { actual: size, floor: limits.floor });
    }
    if size > limits.ceiling {
        return Err(FallbackError::ExeTooLarge { actual: size, ceiling: limits.ceiling });
    }
    let version = win_version::read_file_version(path)
        .map_err(|detail| FallbackError::VersionUnreadable { detail })?;
    if !version.is_meaningful() {
        return Err(FallbackError::VersionUnreadable {
            detail: "the version resource is empty".to_string(),
        });
    }
    Ok(version.to_display())
}

/// Moves a validated binary into its final place atomically.
///
/// A pre-existing valid destination wins (idempotent); an invalid one is
/// replaced. The temp name lives in the destination directory so the final
/// `rename` is a same-directory, same-volume operation that cannot leave a
/// partially written file at the target path.
fn publish(staged_exe: &Path, target: &Path) -> Result<(), FallbackError> {
    let dir = target
        .parent()
        .ok_or_else(|| FallbackError::PublishFailed { detail: "the target path has no parent".into() })?;
    std::fs::create_dir_all(dir)
        .map_err(|err| FallbackError::PublishFailed { detail: describe_io("create the engine folder", &err) })?;

    if target.exists() {
        match evaluate_exe(target) {
            FallbackStatus::Installed { .. } => return Ok(()),
            _ => {
                // Not usable, so replacing it destroys nothing.
                std::fs::remove_file(target).map_err(|err| {
                    FallbackError::PublishFailed {
                        detail: describe_io("remove the unusable previous binary", &err),
                    }
                })?;
            }
        }
    }

    let temp = dir.join(format!(".mpv.exe.{}.{}.tmp", std::process::id(), uuid::Uuid::new_v4()));
    std::fs::rename(staged_exe, &temp).map_err(|err| {
        FallbackError::PublishFailed { detail: describe_io("stage the binary for publishing", &err) }
    })?;

    if let Err(err) = std::fs::rename(&temp, target) {
        let _ = std::fs::remove_file(&temp);
        return Err(FallbackError::PublishFailed {
            detail: describe_io("move the binary into place", &err),
        });
    }
    Ok(())
}

/// Evaluates an already-built engine path and reports the settled status,
/// against the production size window.
///
/// "File exists" is deliberately not enough: the status is `Installed` only
/// when the size gate passes AND a Windows version resource reads back.
pub fn evaluate_exe(path: &Path) -> FallbackStatus {
    evaluate_exe_with_limits(path, ExtractLimits::pinned())
}

/// [`evaluate_exe`] with an injected size window. The install pipeline uses the
/// caller's `InstallOptions` so an injected (test) window is applied
/// consistently to the pre-flight check, the publish step and the status.
pub fn evaluate_exe_with_limits(path: &Path, limits: ExtractLimits) -> FallbackStatus {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return FallbackStatus::NotInstalled,
        Err(err) => {
            return FallbackStatus::Invalid {
                reason: format!("the engine file could not be inspected: {}", describe_io("stat", &err)),
            }
        }
    };
    if !metadata.is_file() {
        return FallbackStatus::Invalid { reason: "the engine path is not a file".to_string() };
    }
    let size = metadata.len();
    if size < limits.floor {
        return FallbackStatus::Invalid {
            reason: format!(
                "the engine file is only {size} bytes, below the {} byte minimum",
                limits.floor
            ),
        };
    }
    if size > limits.ceiling {
        return FallbackStatus::Invalid {
            reason: format!("the engine file is implausibly large ({size} bytes)"),
        };
    }
    match win_version::read_file_version(path) {
        Ok(version) if version.is_meaningful() => FallbackStatus::Installed {
            version: version.to_display(),
            path: path.to_string_lossy().into_owned(),
            size,
        },
        Ok(_) => FallbackStatus::Invalid {
            reason: "the engine file has an empty version resource".to_string(),
        },
        Err(detail) => FallbackStatus::Invalid {
            reason: format!("the engine file has no readable version: {detail}"),
        },
    }
}

/// Status of the pinned version under `local_data_root`.
pub fn status_for(local_data_root: &Path) -> FallbackStatus {
    evaluate_exe(&engine_exe_path(local_data_root, metadata::MPV_VERSION))
}


/// Removes staging directories older than [`metadata::STAGING_MAX_AGE`].
///
/// Exposed for Slice 3 to call at startup (a crashed install leaves one behind)
/// and called at the start of every install.
pub fn cleanup_stale_staging(local_data_root: &Path) -> usize {
    cleanup_stale_staging_older_than(local_data_root, metadata::STAGING_MAX_AGE)
}

/// [`cleanup_stale_staging`] with an explicit age threshold.
///
/// Split out so the age rule is testable without back-dating a directory's
/// timestamp (not portable with plain `std` on Windows). Returns the number of
/// directories removed; a missing staging root is a no-op, not an error.
pub fn cleanup_stale_staging_older_than(
    local_data_root: &Path,
    max_age: std::time::Duration,
) -> usize {
    let root = staging_root(local_data_root);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(err) => {
            log::warn!(
                "[playback_runtime] could not list staging root {}: {err}",
                root.display()
            );
            return 0;
        }
    };

    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok());
        match age {
            Some(age) if age >= max_age => {
                if std::fs::remove_dir_all(&path).is_ok() {
                    removed += 1;
                } else {
                    log::warn!(
                        "[playback_runtime] could not remove stale staging dir {}",
                        path.display()
                    );
                }
            }
            _ => {}
        }
    }
    removed
}

/// Removes the `Zone.Identifier` alternate data stream from a published binary.
///
/// This is the Mark-of-the-Web: a `file:ZoneId=3` stream Windows attaches to
/// files that came from the internet. Leaving it on the engine makes SmartScreen
/// and some AV products treat a verified DrPlay component as untrusted, and it
/// can block execution outright under stricter policies.
///
/// Best-effort by design: the binary is already hash-verified and validated, so
/// a failure here degrades a heuristic, it does not weaken the trust chain.
/// Logged at `warn` because the *next* symptom (a SmartScreen prompt) is
/// otherwise unexplained.
#[cfg(windows)]
fn strip_zone_identifier(published: &Path) {
    use std::os::windows::ffi::OsStrExt;

    const ZONE_IDENTIFIER: &str = ":Zone.Identifier";

    let mut stream_path: Vec<u16> = published.as_os_str().encode_wide().collect();
    stream_path.extend(ZONE_IDENTIFIER.encode_utf16());
    stream_path.push(0);

    // SAFETY: `stream_path` is a NUL-terminated UTF-16 buffer owned by this
    // frame. Deleting a non-existent ADS returns ERROR_FILE_NOT_FOUND, which is
    // the normal case for a local build and not an error worth reporting.
    let deleted = unsafe {
        windows::Win32::Storage::FileSystem::DeleteFileW(windows::core::PCWSTR(stream_path.as_ptr()))
    };
    if let Err(err) = deleted {
        use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};
        if err.code() != ERROR_FILE_NOT_FOUND.to_hresult() && err.code() != ERROR_PATH_NOT_FOUND.to_hresult()
        {
            log::warn!(
                "[playback_runtime] could not strip Zone.Identifier from {}: {err}",
                published.display()
            );
        }
    }
}

#[cfg(not(windows))]
fn strip_zone_identifier(_published: &Path) {}

fn new_staging_name() -> String {
    format!("{}-{}", std::process::id(), uuid::Uuid::new_v4())
}

fn describe_io(action: &str, err: &std::io::Error) -> String {
    let kind = match err.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied",
        std::io::ErrorKind::StorageFull => "no space left on device",
        std::io::ErrorKind::NotFound => "path not found",
        std::io::ErrorKind::AlreadyExists => "already exists",
        _ => "I/O error",
    };
    format!("{action}: {kind}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback_runtime::test_support::{temp_scope_dir, StubTransport};
    use std::sync::Mutex;

    /// Serializes the tests that touch the process-wide install slot, because it
    /// is (by design) global.
    static SLOT_LOCK: Mutex<()> = Mutex::new(());

    fn no_progress(_: FallbackProgress) {}

    fn test_options() -> InstallOptions {
        InstallOptions {
            expected: ExpectedAsset { bytes: 4096, sha256_hex: "00" },
            limits: ExtractLimits { floor: 1024, ceiling: 8 * 1024 * 1024 },
        }
    }

    #[test]
    fn slot_is_exclusive_and_released_on_drop() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let first = try_acquire_install_slot().expect("first acquisition must succeed");
        assert!(try_acquire_install_slot().is_none(), "the slot must be exclusive");
        drop(first);
        assert!(try_acquire_install_slot().is_some(), "dropping the guard must release the slot");
    }

    #[tokio::test]
    async fn second_install_while_one_is_running_reports_already_in_progress() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("install_busy");
        let held = try_acquire_install_slot().expect("take the slot to simulate a running install");

        let transport = StubTransport::failing(FallbackError::Network { detail: "unused".into() });
        let err = install_into(&dir, transport.as_ref(), test_options(), &mut no_progress)
            .await
            .expect_err("a held slot must reject the second install");
        assert!(matches!(err, FallbackError::AlreadyInProgress), "{err:?}");
        assert_eq!(err.code(), "already_in_progress");
        assert_eq!(err.to_string(), "a fallback engine install is already running");

        drop(held);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_failing_install_leaves_an_existing_version_untouched() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("install_preserve");

        // A "previous working install" in another version directory. It is
        // validated by a real version resource, so use a system binary copy.
        let old_version = "2020-01-01-deadbeef";
        let old_dir = dir.join("engines").join("mpv").join(old_version);
        std::fs::create_dir_all(&old_dir).unwrap();
        let old_exe = old_dir.join("mpv.exe");
        copy_system_binary(&old_exe);
        let old_size = std::fs::metadata(&old_exe).unwrap().len();
        let old_bytes = std::fs::read(&old_exe).unwrap();

        // The new install fails at the network step.
        let transport = StubTransport::failing(FallbackError::AssetMissing { status: 404 });
        let err = install_into(&dir, transport.as_ref(), test_options(), &mut no_progress)
            .await
            .expect_err("a 404 must fail the install");
        assert!(matches!(err, FallbackError::AssetMissing { status: 404 }), "{err:?}");

        assert!(old_exe.exists(), "the previous install must survive");
        assert_eq!(std::fs::metadata(&old_exe).unwrap().len(), old_size);
        assert_eq!(std::fs::read(&old_exe).unwrap(), old_bytes, "the bytes must be unchanged");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn staging_is_removed_after_a_forced_failure() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("install_cleanup");
        let transport = StubTransport::failing(FallbackError::HttpStatus { status: 500 });

        let _ = install_into(&dir, transport.as_ref(), test_options(), &mut no_progress).await;

        let staging = staging_root(&dir);
        let leftovers = std::fs::read_dir(&staging)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "the staging root must hold no leftovers after a failure");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn staging_is_removed_after_a_checksum_failure() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("install_cleanup_checksum");
        // Right length, wrong digest.
        let transport = StubTransport::serving(vec![0u8; 4096]);

        let err = install_into(&dir, transport.as_ref(), test_options(), &mut no_progress)
            .await
            .expect_err("a wrong digest must fail the install");
        assert!(matches!(err, FallbackError::ChecksumMismatch { .. }), "{err:?}");

        let staging = staging_root(&dir);
        let leftovers = std::fs::read_dir(&staging)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "the staging root must hold no leftovers");
        assert!(
            !engine_exe_path(&dir, metadata::MPV_VERSION).exists(),
            "nothing may be published on failure"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn successful_install_publishes_a_validated_binary() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("install_success");

        // A real 7z holding a real Windows binary (a system DLL stands in for
        // mpv.exe: same PE + version resource, a couple of hundred KiB).
        let source = system_binary_path();
        let payload = std::fs::read(&source).expect("system binary must be readable");
        let archive_bytes = build_archive_with_engine(&dir, &payload);

        let options = InstallOptions {
            expected: ExpectedAsset {
                bytes: archive_bytes.len() as u64,
                sha256_hex: Box::leak(
                    crate::playback_runtime::download::sha256_hex(&archive_bytes).into_boxed_str(),
                ),
            },
            limits: ExtractLimits { floor: 1024, ceiling: 64 * 1024 * 1024 },
        };

        let transport = StubTransport::serving(archive_bytes);

        // The fixture exceeds the pinned floor check? No: `limits` is injected,
        // so the small system binary passes the size gate and is validated by
        // its real version resource instead.
        let status = install_into(&dir, transport.as_ref(), options, &mut no_progress)
            .await
            .expect("a well-formed install must succeed");
        let FallbackStatus::Installed { version, path, size } = status else {
            panic!("expected Installed, got {status:?}");
        };
        assert_eq!(size, payload.len() as u64);
        assert_eq!(path, engine_exe_path(&dir, metadata::MPV_VERSION).to_string_lossy());
        assert!(!version.is_empty());
        assert_eq!(version.split('.').count(), 4);

        let published = engine_exe_path(&dir, metadata::MPV_VERSION);
        assert_eq!(std::fs::read(&published).unwrap(), payload, "the published bytes must match");
        // The settled status is re-derived from disk. `status_for` uses the
        // PRODUCTION window (100 MiB floor), which this small fixture cannot
        // meet, so the injected limits are used here -- the point of this
        // assertion is that the on-disk state is re-evaluated from scratch, not
        // that it passes the production floor.
        assert_eq!(
            evaluate_exe_with_limits(&published, options.limits),
            FallbackStatus::Installed {
                version: version.clone(),
                path: published.to_string_lossy().into_owned(),
                size: payload.len() as u64,
            }
        );
        // And the production status is honest about the small fixture: it is
        // rejected on size, never reported as installed.
        assert!(matches!(status_for(&dir), FallbackStatus::Invalid { .. }), "{:?}", status_for(&dir));

        // No staging leftovers, no temp files next to the published binary.
        let staging_leftovers = std::fs::read_dir(staging_root(&dir)).map(|e| e.flatten().count()).unwrap_or(0);
        assert_eq!(staging_leftovers, 0);
        let temp_leftovers = std::fs::read_dir(published.parent().unwrap())
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(temp_leftovers, 0, "no temp file may survive a publish");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn install_is_idempotent_when_the_target_is_already_valid() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("install_idempotent");
        let target = engine_exe_path(&dir, metadata::MPV_VERSION);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        copy_system_binary(&target);
        let original = std::fs::read(&target).unwrap();

        // A transport that would fail if it were called at all.
        let transport = StubTransport::failing(FallbackError::Network { detail: "must not be used".into() });
        let status = install_into(&dir, transport.as_ref(), test_options(), &mut no_progress)
            .await
            .expect("an already-valid install must short-circuit");
        assert!(matches!(status, FallbackStatus::Installed { .. }), "{status:?}");
        assert_eq!(std::fs::read(&target).unwrap(), original, "the existing binary must be kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_staging_dirs_are_reclaimed_and_fresh_ones_are_kept() {
        let dir = temp_scope_dir("install_stale");
        let root = staging_root(&dir);
        std::fs::create_dir_all(&root).unwrap();

        let stale = root.join("stale");
        let fresh = root.join("fresh");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::write(stale.join("archive.7z.part"), b"x").unwrap();
        std::fs::write(fresh.join("archive.7z.part"), b"y").unwrap();

        // Back-dating a directory's timestamp is not possible with plain `std`
        // on Windows (FILE_WRITE_ATTRIBUTES is denied on a directory handle
        // opened without it), so the age threshold is injected instead: a zero
        // threshold makes every existing dir "stale", which is exactly the
        // branch under test.
        let removed = cleanup_stale_staging_older_than(&dir, std::time::Duration::ZERO);
        assert_eq!(removed, 2, "both dirs are older than a zero threshold");
        assert!(!stale.exists(), "the stale dir must be gone");
        assert!(!fresh.exists());

        // A fresh dir survives a real threshold, and a missing root is a no-op.
        std::fs::create_dir_all(&fresh).unwrap();
        assert_eq!(cleanup_stale_staging(&dir), 0, "a just-created dir is not stale");
        assert!(fresh.exists(), "a fresh dir must be kept");
        assert_eq!(cleanup_stale_staging(Path::new(r"C:\no\such\root\here")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_of_a_missing_file_is_not_installed() {
        let dir = temp_scope_dir("status_missing");
        assert_eq!(status_for(&dir), FallbackStatus::NotInstalled);
        assert_eq!(evaluate_exe(&dir.join("nope.exe")), FallbackStatus::NotInstalled);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_below_the_floor_is_invalid_not_installed() {
        let dir = temp_scope_dir("status_short");
        let target = engine_exe_path(&dir, metadata::MPV_VERSION);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        // Big enough to exist, far below the 100 MiB floor.
        std::fs::write(&target, vec![0u8; 4096]).unwrap();

        match evaluate_exe(&target) {
            FallbackStatus::Invalid { reason } => {
                assert!(reason.contains("below"), "{reason}");
                assert!(reason.contains("4096"), "{reason}");
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_valid_size_file_full_of_junk_is_invalid_not_installed() {
        let dir = temp_scope_dir("status_junk");
        let target = engine_exe_path(&dir, metadata::MPV_VERSION);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        // Passes the size gate (floor + slack) but is not a PE at all: this is
        // precisely the "file exists therefore installed" trap.
        let fake_size = metadata::MPV_EXE_BYTE_FLOOR + 1024;
        std::fs::write(&target, vec![0x5Au8; fake_size as usize]).unwrap();
        assert_eq!(std::fs::metadata(&target).unwrap().len(), fake_size);

        match evaluate_exe(&target) {
            FallbackStatus::Invalid { reason } => {
                assert!(reason.contains("version"), "{reason}");
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn system_binary_path() -> PathBuf {
        let root = std::env::var("SystemRoot").expect("SystemRoot must be set on Windows");
        PathBuf::from(root).join("System32").join("version.dll")
    }

    fn copy_system_binary(dest: &Path) {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::copy(system_binary_path(), dest).expect("the system binary must be copyable");
    }

    fn build_archive_with_engine(dir: &Path, payload: &[u8]) -> Vec<u8> {
        let archive_path = dir.join("fixture-engine.7z");
        let mut writer = sevenz_rust2::ArchiveWriter::create(&archive_path).expect("create 7z writer");
        writer
            .push_archive_entry(
                sevenz_rust2::ArchiveEntry::new_file(metadata::MPV_EXE_ENTRY),
                Some(std::io::Cursor::new(payload.to_vec())),
            )
            .expect("push the engine entry");
        writer.finish().expect("finish the archive");
        std::fs::read(&archive_path).expect("the fixture archive must be readable")
    }


}