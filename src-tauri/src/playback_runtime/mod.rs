//! Optional, downloadable `mpv.exe` fallback engine.
//!
//! DrPlay ships no `mpv.exe` (the MSI no longer carries the sidecar). When the
//! in-process libmpv engine is unavailable, and the user opts in, this module
//! downloads the pinned upstream build, verifies it, and installs it under the
//! app's local data directory.
//!
//! ## Scope of this module
//!
//! The install service plus the two IPC entry points in [`commands`]. It does
//! NOT choose the playback engine: `ACTIVE_ENGINE` lives in `player::engine_mode`
//! and is only *read* here, through `player::engine_state()`.
//!
//! ## Pipeline
//!
//! ```text
//! metadata.rs  the pinned version/asset/hash, and the mirror hook
//!     |
//! download.rs  stream -> .part -> length gate -> SHA-256 gate
//!     |
//! extract.rs   open the verified 7z -> validate names -> extract ONLY mpv.exe
//!     |
//! install.rs   staging -> size floor -> Windows version read -> atomic publish
//!     |
//! status.rs    what the UI renders (settled state) + progress (in flight)
//!     |
//! commands.rs  the two Tauri commands + the progress event  <- frontend edge
//!     |
//! error.rs     one typed error per actionable failure
//! ```
//!
//! ## Threading
//!
//! Download and verify are async (`tokio`, `reqwest`+rustls). Extraction is
//! CPU-bound and synchronous, so the command handler runs the whole install on
//! `tauri::async_runtime::spawn_blocking` and drives it with `block_on` -- see
//! `commands::install_mpv_fallback`.
//!
//! ## Importing from here
//!
//! Submodules are the source of truth: `playback_runtime::install::status_for`,
//! `playback_runtime::status::FallbackStatus`, ... Only `cleanup_stale_staging`
//! is re-exported at the root, because `lib.rs` calls it during setup.

pub mod commands;
pub mod download;
pub mod error;
pub mod extract;
pub mod install;
pub mod metadata;
pub mod status;
#[cfg(test)]
mod test_support;
#[cfg(windows)]
pub mod win_version;

pub use install::cleanup_stale_staging;
