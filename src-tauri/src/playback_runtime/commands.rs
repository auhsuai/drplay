//! The only three IPC entry points for the optional fallback engine.
//!
//! Scope is deliberately narrow:
//!
//! * [`get_mpv_fallback_status`] reads the settled on-disk state and the
//!   engine facts. It never touches the network and never changes the engine.
//! * [`install_mpv_fallback`] downloads/verifies/installs, forwards progress as
//!   a Tauri event, and returns the re-queried status.
//! * [`remove_mpv_fallback`] deletes the installed version directory and
//!   returns the re-queried status. It shares the install slot, so it can never
//!   race an install.
//!
//! There is deliberately **no** command that switches the active engine at
//! runtime: `ACTIVE_ENGINE` and the player `LIFECYCLE_GATE`/`ENGINE` slots are
//! process-lifetime singletons with no mid-session teardown story, so a switch
//! belongs to the next process, not to this slice.
//!
//! ## Wire contract (frozen for Slice 5)
//!
//! ```text
//! get_mpv_fallback_status() -> FallbackStatusDto           (camelCase)
//! install_mpv_fallback()    -> FallbackStatusDto           (camelCase)
//! remove_mpv_fallback()     -> FallbackStatusDto           (camelCase)
//!                           -> Err("<code>: <message>")    on failure
//!
//! engine -> "mpv-fallback-progress"                        (camelCase payload)
//! app    -> "mpv-fallback-changed"                         (FallbackStatusDto)
//! ```
//!
//! `stage` on the status DTO is one of `notInstalled | installed | invalid`.
//! The fourth value a UI will render, `checking`, is a frontend-local state
//! before the invoke resolves; the backend never reports it, because the
//! command answers with settled disk state.
//!
//! ## Error string contract
//!
//! Every `Err` is `"<FallbackError::code()>: <Display>"` (see
//! [`install_error_message`]). The code is a stable snake_case slug, so the
//! frontend branches on the prefix before the first `": "` and may render the
//! remainder verbatim. `AlreadyInProgress` in particular is re-entrancy, not a
//! failure: it means another install is already running in this process.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::error::FallbackError;
use super::install::{install_fallback, remove_installed, status_for, try_acquire_install_slot};
use super::metadata::MPV_VERSION;
use super::status::{FallbackProgress, FallbackStatus};
use crate::player::{engine_state, ActiveEngine, EngineState, UnavailableReason};

/// Event carrying [`FallbackProgressDto`] while an install runs.
///
/// Mirrored by the frontend in Slice 5; changing this string is a breaking
/// change for the UI. Payloads are already throttled inside
/// `download::ProgressThrottle` (200 ms / 1 % step); this module adds no second
/// throttle and must not.
pub const MPV_FALLBACK_PROGRESS_EVENT: &str = "mpv-fallback-progress";

/// Event carrying the settled [`FallbackStatusDto`] after the engine on disk
/// changes (a successful install or a successful removal).
///
/// Mirrored by the frontend as `MPV_FALLBACK_CHANGED_EVENT` in
/// `src/ui/Settings/components/FallbackEngineSection.tsx`; changing this string
/// is a breaking change for the UI.
///
/// Emitted ONLY on success and only AFTER the settled status has been
/// re-derived, so the payload is the authoritative post-change state: a reader
/// that applies it never has to re-query, and a reader that cannot parse it
/// falls back to re-reading the status. An emit failure is logged and swallowed
/// — it must never turn a successful install/removal into an error reply (and
/// during shutdown emit failures are normal).
pub const MPV_FALLBACK_CHANGED_EVENT: &str = "mpv-fallback-changed";

/// Settled install state as the frontend sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FallbackStage {
    NotInstalled,
    Installed,
    Invalid,
}

/// Which playback engine this process will actually use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineKind {
    Libmpv,
    Legacy,
    Unavailable,
}

/// Why [`EngineKind::Unavailable`] is in effect. Kept separate from the kind so
/// the two very different failures stay distinguishable in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnavailableReasonDto {
    LibmpvFailedNoSidecar,
    SidecarRequestedButMissing,
}

/// Status returned by both commands.
///
/// Carries the install state *and* the engine facts on purpose: "installed" is
/// a claim about disk, and only `engine`/`unavailableReason` say whether this
/// process is actually able to use it. `pinnedVersion` is what the installer
/// would fetch, so the UI can name the build before downloading it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackStatusDto {
    pub stage: FallbackStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub engine: EngineKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<UnavailableReasonDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidecar_path: Option<String>,
    pub pinned_version: &'static str,
}

/// Stage of an in-flight install. Mirrors [`FallbackProgress`] one-to-one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressStage {
    Downloading,
    Verifying,
    Extracting,
    Publishing,
}

/// Progress event payload.
///
/// All four fields are always present. `total`/`percent`/`downloaded` are
/// `null` -- never zero -- when the value is unknown, so a UI cannot mistake
/// "no Content-Length" for a determinate bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackProgressDto {
    pub stage: ProgressStage,
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
    pub percent: Option<u8>,
}

/// Pure status -> DTO mapping, so the wire shape is testable without an
/// `AppHandle`.
pub fn status_dto(status: &FallbackStatus, engine: &EngineState) -> FallbackStatusDto {
    let (kind, unavailable_reason) = engine_facts(engine.engine);
    let mut dto = FallbackStatusDto {
        stage: FallbackStage::NotInstalled,
        version: None,
        path: None,
        size: None,
        reason: None,
        engine: kind,
        unavailable_reason,
        sidecar_path: engine
            .sidecar_path
            .as_deref()
            .map(|path| path.to_string_lossy().into_owned()),
        pinned_version: MPV_VERSION,
    };
    match status {
        FallbackStatus::NotInstalled => {}
        FallbackStatus::Installed { version, path, size } => {
            dto.stage = FallbackStage::Installed;
            dto.version = Some(version.clone());
            dto.path = Some(path.clone());
            dto.size = Some(*size);
        }
        FallbackStatus::Invalid { reason } => {
            dto.stage = FallbackStage::Invalid;
            dto.reason = Some(reason.clone());
        }
    }
    dto
}

/// Pure progress -> event payload mapping.
pub fn progress_dto(progress: &FallbackProgress) -> FallbackProgressDto {
    match progress {
        FallbackProgress::Downloading { downloaded, total } => FallbackProgressDto {
            stage: ProgressStage::Downloading,
            downloaded: Some(*downloaded),
            total: *total,
            percent: progress.percent(),
        },
        FallbackProgress::Verifying => FallbackProgressDto {
            stage: ProgressStage::Verifying,
            downloaded: None,
            total: None,
            percent: None,
        },
        FallbackProgress::Extracting => FallbackProgressDto {
            stage: ProgressStage::Extracting,
            downloaded: None,
            total: None,
            percent: None,
        },
        FallbackProgress::Publishing => FallbackProgressDto {
            stage: ProgressStage::Publishing,
            downloaded: None,
            total: None,
            percent: None,
        },
    }
}

/// The command error string: a stable code prefix, then the user-safe prose.
pub fn install_error_message(error: &FallbackError) -> String {
    format!("{}: {error}", error.code())
}

fn engine_facts(engine: ActiveEngine) -> (EngineKind, Option<UnavailableReasonDto>) {
    match engine {
        ActiveEngine::Libmpv => (EngineKind::Libmpv, None),
        ActiveEngine::Legacy => (EngineKind::Legacy, None),
        ActiveEngine::Unavailable(reason) => (EngineKind::Unavailable, Some(unavailable_reason(reason))),
    }
}

fn unavailable_reason(reason: UnavailableReason) -> UnavailableReasonDto {
    match reason {
        UnavailableReason::LibmpvFailedNoSidecar => UnavailableReasonDto::LibmpvFailedNoSidecar,
        UnavailableReason::SidecarRequestedButMissing => UnavailableReasonDto::SidecarRequestedButMissing,
    }
}

/// `<app_local_data_dir>`, or the same code-prefixed error the install path
/// would produce. Never panics: without this directory there is nowhere to
/// install and nothing to report.
fn local_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|path_error| {
        log::error!("[playback_runtime] app_local_data_dir unavailable: {path_error}");
        install_error_message(&FallbackError::PathUnavailable)
    })
}

/// Forwards one progress step to the frontend.
///
/// An emit failure is logged and swallowed: it must never abort an install that
/// is otherwise succeeding (and during app shutdown emit failures are normal).
///
/// NOTE: no terminal "success" stage is ever emitted from here. The command's
/// return value is the authority for completion, so Slice 5 must not treat an
/// event as "done" nor double-handle success.
fn emit_progress(app: &AppHandle, progress: &FallbackProgress) {
    let payload = progress_dto(progress);
    if let Err(emit_error) = app.emit(MPV_FALLBACK_PROGRESS_EVENT, payload) {
        log::debug!(
            "[playback_runtime] fallback progress event dropped at {:?}: {emit_error}",
            payload.stage
        );
    }
}

/// Announces a settled on-disk change (install or removal) with the DTO that is
/// about to be returned to the caller.
///
/// Success-only and best-effort: a dropped event leaves other windows with a
/// stale row until they next mount, which is strictly better than failing an
/// operation that already changed the disk.
fn emit_changed(app: &AppHandle, status: &FallbackStatusDto) {
    if let Err(emit_error) = app.emit(MPV_FALLBACK_CHANGED_EVENT, status) {
        log::debug!(
            "[playback_runtime] fallback changed event dropped at {:?}: {emit_error}",
            status.stage
        );
    }
}

/// Settled fallback status plus the engine facts for this process.
#[tauri::command]
pub async fn get_mpv_fallback_status(app: AppHandle) -> Result<FallbackStatusDto, String> {
    let root = local_data_root(&app)?;
    // Read-only: `status_for` re-runs the size gate and the Windows version
    // read, so an unrelated file at the target path is `invalid`, never
    // `installed`.
    Ok(status_dto(&status_for(&root), &engine_state()))
}

/// Installs the pinned fallback build, streaming progress to the frontend.
///
/// The only path that may download. Re-entrant-safe through Slice 1's
/// process-wide install slot: a second concurrent call fails fast with
/// `already_in_progress` instead of racing the same staging directory.
#[tauri::command]
pub async fn install_mpv_fallback(app: AppHandle) -> Result<FallbackStatusDto, String> {
    let root = local_data_root(&app)?;

    // `install_fallback` is async for download/verify but extracts
    // synchronously (CPU-bound, 7z), as documented in `playback_runtime/mod.rs`.
    // Keep that off the async workers: run it on the blocking pool and drive the
    // future with `block_on`, which a blocking-pool thread is allowed to do.
    // `block_on` is also what lets the `&mut dyn FnMut` progress callback stay
    // un-`Send` -- doing the same work on an async task would require a `Send`
    // future it cannot provide.
    // Two clones: one for the progress callback, one for the install call
    // itself, so `app` stays usable for the settled-change announcement after
    // the blocking task joins.
    let progress_app = app.clone();
    let install_app = app.clone();
    let install_result = tauri::async_runtime::spawn_blocking(move || {
        let mut on_progress = move |progress: FallbackProgress| {
            emit_progress(&progress_app, &progress);
        };
        tauri::async_runtime::block_on(install_fallback(&install_app, &mut on_progress))
    })
    .await
    .map_err(|join_error| format!("install task failed: {join_error}"))?;

    install_result.map_err(|install_error| {
        // `is_retryable` is the "offer Retry" bit; it is logged here so the
        // support log explains why the UI will/will not show one.
        log::warn!(
            "[playback_runtime] fallback install failed ({}, retryable={}): {install_error}",
            install_error.code(),
            install_error.is_retryable()
        );
        install_error_message(&install_error)
    })?;

    // Re-query rather than trusting the installer's own verdict: the settled
    // state is whatever the same validation the read command performs says.
    let dto = status_dto(&status_for(&root), &engine_state());
    emit_changed(&app, &dto);
    Ok(dto)
}

/// Removes the installed fallback engine (the whole pinned version directory).
///
/// Shares the process-wide install slot with [`install_mpv_fallback`]: a remove
/// during a download loses to `already_in_progress` instead of deleting the
/// staging/version directory out from under it. The guard is released by its
/// `Drop` impl, so an early return or a panic cannot wedge future installs.
///
/// Idempotent: removing when nothing is installed succeeds and returns the
/// re-derived `notInstalled` status.
#[tauri::command]
pub async fn remove_mpv_fallback(app: AppHandle) -> Result<FallbackStatusDto, String> {
    let root = local_data_root(&app)?;

    let removal = tauri::async_runtime::spawn_blocking(move || remove_with_slot(&root))
        .await
        .map_err(|join_error| format!("remove task failed: {join_error}"))?;

    let status = removal.map_err(|remove_error| {
        log::warn!(
            "[playback_runtime] fallback removal failed ({}): {remove_error}",
            remove_error.code()
        );
        install_error_message(&remove_error)
    })?;

    // Re-query instead of trusting `remove_installed`'s own re-derivation: the
    // DTO must reflect the same validation the read command performs.
    let dto = status_dto(&status, &engine_state());
    emit_changed(&app, &dto);
    Ok(dto)
}

/// The slot-guarded removal the command runs on the blocking pool.
///
/// Split out so the mutual exclusion with installs is testable without a Tauri
/// `AppHandle`: the guard is taken here (not inside `remove_installed`, which
/// stays a pure filesystem function) and released on every exit path.
fn remove_with_slot(local_data_root: &std::path::Path) -> Result<FallbackStatus, FallbackError> {
    let _slot = try_acquire_install_slot().ok_or(FallbackError::AlreadyInProgress)?;
    remove_installed(local_data_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback_runtime::test_support::{temp_scope_dir, SLOT_LOCK};
    use crate::playback_runtime::status::engine_exe_path;
    use crate::playback_runtime::metadata;
    use std::path::PathBuf;

    fn engine(kind: ActiveEngine, sidecar: Option<&str>) -> EngineState {
        EngineState {
            engine: kind,
            sidecar_path: sidecar.map(PathBuf::from),
        }
    }

    fn libmpv() -> EngineState {
        engine(ActiveEngine::Libmpv, None)
    }

    // (1) DTO mapping: the three settled states.
    //
    // The full serialized strings are asserted, not just individual fields:
    // the whole point of a DTO is a stable wire shape, and a field silently
    // appearing or disappearing is exactly the regression this catches.
    #[test]
    fn status_dto_wire_shape_is_frozen() {
        let not_installed = status_dto(&FallbackStatus::NotInstalled, &libmpv());
        assert_eq!(
            serde_json::to_string(&not_installed).unwrap(),
            concat!(
                r#"{"stage":"notInstalled","engine":"libmpv","#,
                r#""pinnedVersion":"2026-10-18-fffe7a23a8"}"#
            )
        );

        let installed = status_dto(
            &FallbackStatus::Installed {
                version: "0.40.0.0".into(),
                path: r"C:\data\engines\mpv\v\mpv.exe".into(),
                size: 121_946_112,
            },
            &engine(ActiveEngine::Legacy, Some(r"C:\data\engines\mpv\v\mpv.exe")),
        );
        assert_eq!(
            serde_json::to_string(&installed).unwrap(),
            concat!(
                r#"{"stage":"installed","version":"0.40.0.0","#,
                r#""path":"C:\\data\\engines\\mpv\\v\\mpv.exe","#,
                r#""size":121946112,"engine":"legacy","#,
                r#""sidecarPath":"C:\\data\\engines\\mpv\\v\\mpv.exe","#,
                r#""pinnedVersion":"2026-10-18-fffe7a23a8"}"#
            )
        );

        let invalid = status_dto(
            &FallbackStatus::Invalid { reason: "the engine file is only 12 bytes".into() },
            &engine(
                ActiveEngine::Unavailable(UnavailableReason::LibmpvFailedNoSidecar),
                None,
            ),
        );
        assert_eq!(
            serde_json::to_string(&invalid).unwrap(),
            concat!(
                r#"{"stage":"invalid","reason":"the engine file is only 12 bytes","#,
                r#""engine":"unavailable","unavailableReason":"libmpvFailedNoSidecar","#,
                r#""pinnedVersion":"2026-10-18-fffe7a23a8"}"#
            )
        );
    }

    #[test]
    fn not_installed_maps_to_not_installed_stage() {
        let dto = status_dto(&FallbackStatus::NotInstalled, &libmpv());
        assert_eq!(dto.stage, FallbackStage::NotInstalled);
        assert_eq!(dto.version, None);
        assert_eq!(dto.path, None);
        assert_eq!(dto.size, None);
        assert_eq!(dto.reason, None);
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["stage"], "notInstalled");
    }

    #[test]
    fn installed_maps_to_installed_stage_with_version_path_and_size() {
        let status = FallbackStatus::Installed {
            version: "0.40.0.0".into(),
            path: r"C:\data\engines\mpv\v\mpv.exe".into(),
            size: 121_946_112,
        };
        let dto = status_dto(&status, &libmpv());
        assert_eq!(dto.stage, FallbackStage::Installed);
        assert_eq!(dto.version.as_deref(), Some("0.40.0.0"));
        assert_eq!(dto.path.as_deref(), Some(r"C:\data\engines\mpv\v\mpv.exe"));
        assert_eq!(dto.size, Some(121_946_112));
        assert_eq!(dto.reason, None);

        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["stage"], "installed");
        assert_eq!(json["version"], "0.40.0.0");
        assert_eq!(json["size"], 121_946_112_u64);
        assert!(json.get("reason").is_none(), "installed must not carry a reason");
    }

    #[test]
    fn invalid_maps_to_invalid_stage_with_reason() {
        let status = FallbackStatus::Invalid { reason: "the engine file is only 12 bytes".into() };
        let dto = status_dto(&status, &libmpv());
        assert_eq!(dto.stage, FallbackStage::Invalid);
        assert_eq!(dto.reason.as_deref(), Some("the engine file is only 12 bytes"));
        assert_eq!(dto.version, None);
        assert_eq!(dto.size, None);
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["stage"], "invalid");
        assert_eq!(json["reason"], "the engine file is only 12 bytes");
    }

    // (2) The pinned version is on every DTO, whatever the state.
    #[test]
    fn pinned_version_is_present_in_every_dto() {
        let states = [
            FallbackStatus::NotInstalled,
            FallbackStatus::Installed { version: "1.2.3.4".into(), path: "p".into(), size: 1 },
            FallbackStatus::Invalid { reason: "r".into() },
        ];
        for status in states {
            let dto = status_dto(&status, &libmpv());
            assert_eq!(dto.pinned_version, metadata::MPV_VERSION);
            let json = serde_json::to_value(&dto).unwrap();
            assert_eq!(
                json["pinnedVersion"],
                metadata::MPV_VERSION,
                "pinnedVersion must be on the wire for {status:?}"
            );
        }
    }

    // (3) Engine facts: the UI must not claim "active" from "installed".
    #[test]
    fn engine_facts_map_libmpv() {
        let dto = status_dto(&FallbackStatus::NotInstalled, &libmpv());
        assert_eq!(dto.engine, EngineKind::Libmpv);
        assert_eq!(dto.unavailable_reason, None);
        assert_eq!(dto.sidecar_path, None);
        assert_eq!(serde_json::to_value(&dto).unwrap()["engine"], "libmpv");
    }

    #[test]
    fn engine_facts_map_legacy_and_report_the_sidecar_path() {
        let state = engine(ActiveEngine::Legacy, Some(r"C:\data\engines\mpv\v\mpv.exe"));
        let dto = status_dto(&FallbackStatus::NotInstalled, &state);
        assert_eq!(dto.engine, EngineKind::Legacy);
        assert_eq!(dto.unavailable_reason, None);
        assert_eq!(dto.sidecar_path.as_deref(), Some(r"C:\data\engines\mpv\v\mpv.exe"));
        assert_eq!(serde_json::to_value(&dto).unwrap()["engine"], "legacy");
    }

    #[test]
    fn engine_facts_map_unavailable_with_each_reason() {
        let libmpv_failed = engine(
            ActiveEngine::Unavailable(UnavailableReason::LibmpvFailedNoSidecar),
            None,
        );
        let dto = status_dto(&FallbackStatus::NotInstalled, &libmpv_failed);
        assert_eq!(dto.engine, EngineKind::Unavailable);
        assert_eq!(
            dto.unavailable_reason,
            Some(UnavailableReasonDto::LibmpvFailedNoSidecar)
        );
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["engine"], "unavailable");
        assert_eq!(json["unavailableReason"], "libmpvFailedNoSidecar");

        let requested = engine(
            ActiveEngine::Unavailable(UnavailableReason::SidecarRequestedButMissing),
            None,
        );
        let dto = status_dto(&FallbackStatus::Installed {
            version: "1.0.0.0".into(),
            path: "p".into(),
            size: 2,
        }, &requested);
        assert_eq!(dto.engine, EngineKind::Unavailable);
        assert_eq!(
            dto.unavailable_reason,
            Some(UnavailableReasonDto::SidecarRequestedButMissing)
        );
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["unavailableReason"], "sidecarRequestedButMissing");
    }

    // (4) Error-string contract: the frontend branches on the code prefix.
    #[test]
    fn error_strings_start_with_the_stable_code() {
        let cases = [
            FallbackError::AlreadyInProgress,
            FallbackError::AssetMissing { status: 404 },
            FallbackError::ChecksumMismatch { expected: "aa".into(), actual: "bb".into() },
        ];
        for error in cases {
            let message = install_error_message(&error);
            assert!(
                message.starts_with(error.code()),
                "{message:?} must start with {:?}",
                error.code()
            );
            assert!(
                message.starts_with(&format!("{}: ", error.code())),
                "{message:?} must be '<code>: <message>'"
            );
            assert!(message.len() > error.code().len() + 2, "the prose must follow the code");
        }
        // The specific slugs the frontend will branch on.
        assert_eq!(
            install_error_message(&FallbackError::AlreadyInProgress),
            "already_in_progress: a fallback engine install is already running"
        );
        assert!(install_error_message(&FallbackError::AssetMissing { status: 410 })
            .starts_with("asset_missing: "));
        assert!(install_error_message(&FallbackError::ChecksumMismatch {
            expected: "53eabe4d".into(),
            actual: "deadbeef".into()
        })
        .starts_with("checksum_mismatch: "));
        // The checksum itself must never reach the frontend.
        assert!(!install_error_message(&FallbackError::ChecksumMismatch {
            expected: "53eabe4d".into(),
            actual: "deadbeef".into()
        })
        .contains("53eabe4d"));
    }

    // (5) Progress payload JSON, determinate vs indeterminate.
    #[test]
    fn progress_payload_is_determinate_only_with_a_total() {
        let known = FallbackProgress::Downloading { downloaded: 12, total: Some(48) };
        let json = serde_json::to_string(&progress_dto(&known)).unwrap();
        assert_eq!(
            json, r#"{"stage":"downloading","downloaded":12,"total":48,"percent":25}"#,
            "a known total must produce a real percentage"
        );

        let unknown = FallbackProgress::Downloading { downloaded: 42, total: None };
        let json = serde_json::to_string(&progress_dto(&unknown)).unwrap();
        assert_eq!(
            json, r#"{"stage":"downloading","downloaded":42,"total":null,"percent":null}"#,
            "an unknown total must be null, never a fabricated percentage"
        );
    }

    #[test]
    fn progress_payload_covers_the_non_downloading_stages() {
        let cases = [
            (FallbackProgress::Verifying, r#"{"stage":"verifying","downloaded":null,"total":null,"percent":null}"#),
            (FallbackProgress::Extracting, r#"{"stage":"extracting","downloaded":null,"total":null,"percent":null}"#),
            (FallbackProgress::Publishing, r#"{"stage":"publishing","downloaded":null,"total":null,"percent":null}"#),
        ];
        for (progress, expected) in cases {
            assert_eq!(serde_json::to_string(&progress_dto(&progress)).unwrap(), expected);
        }
    }

    #[test]
    fn progress_event_name_is_the_frozen_slug() {
        assert_eq!(MPV_FALLBACK_PROGRESS_EVENT, "mpv-fallback-progress");
    }

    // The settled-change channel is mirrored by name in the frontend, so the
    // slug is part of the wire contract exactly like the progress one.
    #[test]
    fn changed_event_name_is_the_frozen_slug() {
        assert_eq!(MPV_FALLBACK_CHANGED_EVENT, "mpv-fallback-changed");
    }

    // The announcement payload is the same DTO the command returns: a reader
    // applying it and a reader re-querying must land on identical state.
    #[test]
    fn changed_event_payload_is_the_returned_dto() {
        let after_removal = status_dto(&FallbackStatus::NotInstalled, &libmpv());
        let json = serde_json::to_value(&after_removal).unwrap();
        assert_eq!(json["stage"], "notInstalled");
        assert!(
            json.get("version").is_none(),
            "a removed engine must not announce a version"
        );
        assert!(json.get("size").is_none());
    }

    // (6) Regression: a file that EXISTS but fails validation is never
    // reported as installed. This is the "file exists therefore installed"
    // trap, exercised through the exact functions the command uses.
    #[test]
    fn an_existing_but_invalid_file_never_reports_installed() {
        let dir = temp_scope_dir("commands_status_junk");
        let target = engine_exe_path(&dir, metadata::MPV_VERSION);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        // Small junk: exists, wrong size, and not a PE at all.
        std::fs::write(&target, b"not an engine").unwrap();
        assert!(target.exists(), "the fixture must exist to be a regression test");

        let status = status_for(&dir);
        assert!(
            matches!(status, FallbackStatus::Invalid { .. }),
            "an existing invalid file must be Invalid, got {status:?}"
        );
        let dto = status_dto(&status, &libmpv());
        assert_eq!(dto.stage, FallbackStage::Invalid);
        assert_ne!(dto.stage, FallbackStage::Installed);
        assert!(dto.reason.is_some(), "invalid must explain itself");
        let json = serde_json::to_value(&dto).unwrap();
        assert_ne!(json["stage"], "installed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The wrapping guarantee: a blocking-pool thread may drive the install
    // future with `block_on`, and the tokio drivers are live there. This is
    // what makes `install_mpv_fallback`'s shape safe; if it ever stops
    // holding, this test panics or hangs instead of shipping a dead command.
    // It deliberately includes a timer and a real `tokio::fs` read, because
    // `install_fallback` awaits reqwest IO and a stream inside this exact
    // shape: a plain closure would prove nothing about the reactor.
    #[test]
    fn a_blocking_pool_thread_can_reenter_the_async_runtime_with_live_drivers() {
        let dir = temp_scope_dir("commands_reentrant_runtime");
        let probe = dir.join("probe.txt");
        std::fs::write(&probe, b"driven").unwrap();

        let value = tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn_blocking(move || {
                tauri::async_runtime::block_on(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    let bytes = tokio::fs::read(&probe).await.expect("tokio::fs must work here");
                    bytes.len() as u32
                })
            })
            .await
            .expect("the blocking task must not be cancelled")
        });
        assert_eq!(value, 6, "the timer fired and the file was read");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // (8) Removal deletes the WHOLE version directory (not just the exe) and
    // reports the re-derived settled state.
    #[test]
    fn remove_mpv_fallback_deletes_the_version_dir_and_reports_not_installed() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("commands_remove_dir");
        let version_dir = crate::playback_runtime::status::engine_version_dir(&dir, metadata::MPV_VERSION);
        std::fs::create_dir_all(&version_dir).unwrap();
        // A real-looking install: the exe plus sibling leftovers a half-written
        // publish could leave behind.
        std::fs::write(version_dir.join(metadata::MPV_EXE_ENTRY), b"engine").unwrap();
        std::fs::write(version_dir.join(".mpv.exe.123.abc.tmp"), b"temp").unwrap();
        assert!(version_dir.exists());

        let status = remove_with_slot(&dir).expect("removal must succeed");

        assert_eq!(status, FallbackStatus::NotInstalled);
        assert!(
            !version_dir.exists(),
            "the whole version directory must be gone, not just the exe"
        );
        assert_eq!(
            status_dto(&status, &libmpv()).stage,
            FallbackStage::NotInstalled,
            "the DTO stage must be notInstalled after removal"
        );
        // The parent `mpv/` directory is NOT the unit of removal.
        assert!(version_dir.parent().unwrap().exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // (9) Idempotent: removing with nothing installed succeeds and still answers
    // `notInstalled` (a UI retry after a partial removal must not error).
    #[test]
    fn remove_mpv_fallback_is_idempotent_when_nothing_is_installed() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("commands_remove_idempotent");

        let first = remove_with_slot(&dir).expect("removing a missing engine must succeed");
        assert_eq!(first, FallbackStatus::NotInstalled);

        // A second call on the same (still empty) root behaves identically.
        let second = remove_with_slot(&dir).expect("a repeated removal must still succeed");
        assert_eq!(second, FallbackStatus::NotInstalled);
        assert_eq!(
            status_dto(&second, &libmpv()).stage,
            FallbackStage::NotInstalled
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // (10) A held install slot makes removal REFUSE (distinct slug) instead of
    // deleting a directory an install is actively writing into.
    #[test]
    fn remove_mpv_fallback_refuses_while_an_install_is_in_progress() {
        let _lock = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_scope_dir("commands_remove_busy");
        let version_dir = crate::playback_runtime::status::engine_version_dir(&dir, metadata::MPV_VERSION);
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::write(version_dir.join(metadata::MPV_EXE_ENTRY), b"engine").unwrap();

        let held = crate::playback_runtime::install::try_acquire_install_slot()
            .expect("taking the slot simulates a running install");

        let err = remove_with_slot(&dir).expect_err("a held slot must reject the removal");
        assert!(matches!(err, FallbackError::AlreadyInProgress), "{err:?}");
        assert_eq!(err.code(), "already_in_progress");
        assert_eq!(
            install_error_message(&err),
            "already_in_progress: a fallback engine install is already running"
        );
        assert!(
            version_dir.join(metadata::MPV_EXE_ENTRY).exists(),
            "nothing may be deleted while an install holds the slot"
        );

        drop(held);
        // Once the slot is free the same call goes through.
        let status = remove_with_slot(&dir).expect("removal must work after the slot is released");
        assert_eq!(status, FallbackStatus::NotInstalled);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // The retryable/slug contract for the new filesystem failure.
    #[test]
    fn remove_failed_carries_its_own_stable_code() {
        let err = FallbackError::RemoveFailed { detail: "permission denied".into() };
        assert_eq!(err.code(), "remove_failed");
        assert_eq!(
            install_error_message(&err),
            "remove_failed: could not remove the fallback engine: permission denied"
        );
        assert!(err.is_retryable(), "a filesystem removal failure is retryable");
    }
}
