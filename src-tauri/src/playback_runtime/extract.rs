//! Single-entry extraction of `mpv.exe` from the verified archive.
//!
//! Only the pinned entry is written. Nothing else from the archive is
//! materialised, and the destination is always inside the caller-supplied
//! staging directory.
//!
//! ## Why names are validated even though we extract exactly one file
//!
//! We match on the entry name, so the name is the one piece of attacker-
//! influenced data that participates in a filesystem decision. An upstream
//! compromise, a poisoned mirror, or a future re-pin to a hostile build could
//! ship `../../evil.exe` or `C:\Windows\System32\evil.exe`. The SHA-256 gate
//! catches that today (the hash is pinned), but the hash is a single constant
//! that will be edited during every version bump -- the name check is the
//! defence that survives that edit. It costs nothing, so it always runs.

use std::io;
use std::path::{Path, PathBuf};

use sevenz_rust2::{ArchiveEntry, ArchiveReader, Password};

use super::error::FallbackError;
use super::metadata;

/// Size window the extracted executable must fall into.
#[derive(Debug, Clone, Copy)]
pub struct ExtractLimits {
    pub floor: u64,
    pub ceiling: u64,
}

impl ExtractLimits {
    /// The production window (100 MiB floor, 300 MiB decompression-bomb guard).
    pub const fn pinned() -> Self {
        Self { floor: metadata::MPV_EXE_BYTE_FLOOR, ceiling: metadata::MPV_EXE_BYTE_CEILING }
    }
}

/// Result of a successful extraction.
#[derive(Debug)]
pub struct ExtractedExe {
    pub path: PathBuf,
    pub size: u64,
}

/// Validates a single archive entry path.
///
/// Rejects: empty names, absolute paths (`/x`, `\x`, `C:\x`, `C:x`), any `..`
/// segment, any `.` segment, backslashes (ambiguous separator on Windows), and
/// NUL bytes. Pure function -- no IO, so it is directly testable.
pub fn validate_entry_path(name: &str) -> Result<(), FallbackError> {
    let unsafe_entry = || FallbackError::UnsafeEntry { name: name.to_string() };

    if name.is_empty() || name.contains('\0') {
        return Err(unsafe_entry());
    }
    // A backslash is a separator on Windows but a literal character in the 7z
    // spec (which mandates '/'), so its presence is ambiguous; reject it.
    if name.contains('\\') {
        return Err(unsafe_entry());
    }
    if name.starts_with('/') {
        return Err(unsafe_entry());
    }
    // Drive-relative (`C:foo`) is as dangerous as absolute (`C:\foo`).
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(unsafe_entry());
    }
    for segment in name.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(unsafe_entry());
        }
    }
    Ok(())
}

/// Whether `name` is exactly the pinned engine entry at the archive root.
fn is_engine_entry(name: &str) -> bool {
    name == metadata::MPV_EXE_ENTRY
}

/// Opens the verified archive, validates every entry name, and extracts only
/// `mpv.exe` into `staging_dir`.
///
/// The extracted file is `staging_dir/mpv.exe`. The returned size is the real
/// number of bytes written, and it is checked against `limits` both before
/// (from the archive header, as a cheap early exit) and after (the actual
/// write, which is what the install trusts).
pub fn extract_engine_exe(
    archive_path: &Path,
    staging_dir: &Path,
    limits: ExtractLimits,
) -> Result<ExtractedExe, FallbackError> {
    let mut reader = ArchiveReader::open(archive_path, Password::empty())
        .map_err(|e| FallbackError::ArchiveUnreadable { detail: describe_archive_error(&e) })?;

    // Pass 1: header only -- no decompression. Rejects unsafe names anywhere in
    // the archive and locates the engine entry.
    let mut found = false;
    for entry in &reader.archive().files {
        validate_entry_path(&entry.name)?;
        if is_engine_entry(&entry.name) {
            found = true;
            if entry.is_directory || !entry.has_stream {
                return Err(FallbackError::EntryMissing);
            }
            if entry.size < limits.floor {
                return Err(FallbackError::ExeTooSmall { actual: entry.size, floor: limits.floor });
            }
            if entry.size > limits.ceiling {
                return Err(FallbackError::ExeTooLarge { actual: entry.size, ceiling: limits.ceiling });
            }
        }
    }
    if !found {
        return Err(FallbackError::EntryMissing);
    }

    let out_path = staging_dir.join(metadata::MPV_EXE_ENTRY);
    tokio_free_create_parent(&out_path)?;
    assert_within(staging_dir, &out_path)?;

    // Pass 2: decode. `for_each_entries` walks the archive in order; returning
    // `Ok(false)` stops as soon as the engine entry is written, so the rest of
    // the archive is never decompressed.
    let mut write_error: Option<FallbackError> = None;
    let mut written: u64 = 0;
    let mut saw_entry = false;

    let walk_result = reader.for_each_entries(|entry: &ArchiveEntry, data: &mut dyn io::Read| {
        if write_error.is_some() {
            return Ok(false);
        }
        if !is_engine_entry(&entry.name) {
            return Ok(true);
        }
        saw_entry = true;
        match write_entry(data, &out_path, limits.ceiling) {
            Ok(size) => {
                written = size;
                Ok(false)
            }
            Err(err) => {
                write_error = Some(err);
                Ok(false)
            }
        }
    });

    if let Some(err) = write_error {
        let _ = std::fs::remove_file(&out_path);
        return Err(err);
    }
    walk_result.map_err(|e| FallbackError::ArchiveUnreadable { detail: describe_archive_error(&e) })?;

    if !saw_entry {
        return Err(FallbackError::EntryMissing);
    }

    // The post-write gate is the authoritative one: a header can lie about
    // `size`, the bytes on disk cannot.
    if written < limits.floor {
        let _ = std::fs::remove_file(&out_path);
        return Err(FallbackError::ExeTooSmall { actual: written, floor: limits.floor });
    }
    if written > limits.ceiling {
        let _ = std::fs::remove_file(&out_path);
        return Err(FallbackError::ExeTooLarge { actual: written, ceiling: limits.ceiling });
    }

    Ok(ExtractedExe { path: out_path, size: written })
}

/// Streams one entry to `out_path`, refusing to exceed `ceiling` bytes.
fn write_entry(data: &mut dyn io::Read, out_path: &Path, ceiling: u64) -> Result<u64, FallbackError> {
    use std::io::Write as _;

    let mut file = std::fs::File::create(out_path)
        .map_err(|e| FallbackError::PublishFailed { detail: format!("could not create the extracted file: {}", io_kind(&e)) })?;

    let mut buffer = vec![0u8; 256 * 1024];
    let mut written: u64 = 0;
    loop {
        let read = match data.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(ref e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => {
                return Err(FallbackError::ArchiveUnreadable {
                    detail: format!("the archive stream failed: {}", io_kind(&e)),
                })
            }
        };
        written += read as u64;
        if written > ceiling {
            return Err(FallbackError::ExeTooLarge { actual: written, ceiling });
        }
        file.write_all(&buffer[..read]).map_err(|e| {
            FallbackError::PublishFailed {
                detail: format!("could not write the extracted file: {}", io_kind(&e)),
            }
        })?;
    }
    file.flush()
        .map_err(|e| FallbackError::PublishFailed { detail: format!("could not flush the extracted file: {}", io_kind(&e)) })?;
    Ok(written)
}

fn tokio_free_create_parent(path: &Path) -> Result<(), FallbackError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| FallbackError::PublishFailed {
            detail: format!("could not create the extraction folder: {}", io_kind(&e)),
        })?;
    }
    Ok(())
}

/// Defence in depth: the computed output path must stay inside `staging`.
fn assert_within(staging: &Path, candidate: &Path) -> Result<(), FallbackError> {
    let parent = candidate.parent().unwrap_or(candidate);
    if !parent.starts_with(staging) {
        return Err(FallbackError::UnsafeEntry {
            name: candidate.to_string_lossy().into_owned(),
        });
    }
    if candidate.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(FallbackError::UnsafeEntry {
            name: candidate.to_string_lossy().into_owned(),
        });
    }
    Ok(())
}

fn io_kind(err: &io::Error) -> &'static str {
    match err.kind() {
        io::ErrorKind::PermissionDenied => "permission denied",
        io::ErrorKind::StorageFull => "no space left on device",
        io::ErrorKind::NotFound => "path not found",
        _ => "I/O error",
    }
}

/// 7z errors carry decoded archive internals; only the class is surfaced.
fn describe_archive_error(err: &sevenz_rust2::Error) -> String {
    use sevenz_rust2::Error as E;
    match err {
        E::BadSignature(_) => "the archive signature is not 7z".to_string(),
        E::UnsupportedVersion { .. } => "the archive uses an unsupported 7z version".to_string(),
        E::ChecksumVerificationFailed | E::NextHeaderCrcMismatch => {
            "the archive failed its internal checksum".to_string()
        }
        E::UnsupportedCompressionMethod(_) | E::ExternalUnsupported | E::Unsupported(_) => {
            "the archive uses an unsupported compression method".to_string()
        }
        E::PasswordRequired | E::MaybeBadPassword(_) => {
            "the archive is encrypted".to_string()
        }
        E::FileNotFound => "the archive could not be found".to_string(),
        E::Io(_, _) | E::FileOpen(_, _) => "the archive could not be read".to_string(),
        E::MaxMemLimited { .. } => "the archive needs more memory than allowed".to_string(),
        _ => "the archive could not be parsed".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback_runtime::test_support::temp_scope_dir;

    const SMALL_LIMITS: ExtractLimits = ExtractLimits { floor: 1024, ceiling: 8 * 1024 * 1024 };

    fn build_archive(dir: &Path, entries: &[(&str, Vec<u8>)]) -> PathBuf {
        let path = dir.join("fixture.7z");
        let mut writer = sevenz_rust2::ArchiveWriter::create(&path).expect("create 7z writer");
        for (name, body) in entries {
            writer
                .push_archive_entry(
                    sevenz_rust2::ArchiveEntry::new_file(name),
                    Some(io::Cursor::new(body.clone())),
                )
                .expect("push archive entry");
        }
        writer.finish().expect("finish 7z archive");
        path
    }

    #[test]
    fn rejects_parent_traversal() {
        let err = validate_entry_path("../../evil.exe").expect_err("traversal must be rejected");
        assert!(
            matches!(&err, FallbackError::UnsafeEntry { name } if name == "../../evil.exe"),
            "{err:?}"
        );
        assert_eq!(err.code(), "unsafe_entry");
    }

    #[test]
    fn rejects_absolute_paths() {
        for name in ["/abs/evil.exe", "/evil.exe", r"C:\Windows\evil.exe", r"\evil.exe", "C:evil.exe"] {
            let err = validate_entry_path(name).expect_err("absolute path must be rejected");
            assert!(matches!(err, FallbackError::UnsafeEntry { .. }), "{name} -> {err:?}");
        }
    }

    #[test]
    fn rejects_dot_segments_nul_and_empty() {
        for name in ["", "a/./b", "./mpv.exe", "a//b", "mpv.exe\0", "a\\b"] {
            assert!(
                matches!(validate_entry_path(name), Err(FallbackError::UnsafeEntry { .. })),
                "{name:?} must be rejected"
            );
        }
    }

    #[test]
    fn accepts_flat_and_nested_relative_names() {
        for name in ["mpv.exe", "doc/mpv.exe", "LICENSE.GPL", "a/b/c.txt"] {
            assert!(validate_entry_path(name).is_ok(), "{name:?} must be accepted");
        }
    }

    #[test]
    fn extracts_only_the_engine_entry_from_a_real_archive() {
        let dir = temp_scope_dir("ex_ok");
        let payload = vec![0x5Au8; 4096];
        let archive = build_archive(
            &dir,
            &[
                ("LICENSE.GPL", b"license text".to_vec()),
                ("mpv.exe", payload.clone()),
                ("doc/manual.html", b"<html></html>".to_vec()),
            ],
        );
        let staging = dir.join("stage");

        let extracted = extract_engine_exe(&archive, &staging, SMALL_LIMITS).expect("extract");
        assert_eq!(extracted.size, 4096);
        assert_eq!(extracted.path, staging.join("mpv.exe"));
        assert_eq!(std::fs::read(&extracted.path).unwrap(), payload);
        assert!(!staging.join("LICENSE.GPL").exists(), "no other entry may be written");
        assert!(!staging.join("doc").exists(), "no directories may be created");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_engine_entry_is_reported() {
        let dir = temp_scope_dir("ex_missing");
        let archive = build_archive(&dir, &[("LICENSE.GPL", b"license".to_vec())]);
        let err = extract_engine_exe(&archive, &dir.join("stage"), SMALL_LIMITS)
            .expect_err("absence must be reported");
        assert!(matches!(err, FallbackError::EntryMissing), "{err:?}");
        assert_eq!(err.code(), "entry_missing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsafe_entry_inside_the_archive_aborts_before_writing() {
        let dir = temp_scope_dir("ex_unsafe");
        let archive = build_archive(
            &dir,
            &[
                ("mpv.exe", vec![0x11u8; 4096]),
                ("../../evil.exe", b"pwn".to_vec()),
            ],
        );
        let staging = dir.join("stage");
        let err = extract_engine_exe(&archive, &staging, SMALL_LIMITS)
            .expect_err("an unsafe sibling entry must abort the extraction");
        match err {
            FallbackError::UnsafeEntry { name } => assert_eq!(name, "../../evil.exe"),
            other => panic!("expected UnsafeEntry, got {other:?}"),
        }
        assert!(!staging.join("mpv.exe").exists(), "nothing may be written");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entry_below_the_floor_is_rejected() {
        let dir = temp_scope_dir("ex_small");
        let archive = build_archive(&dir, &[("mpv.exe", vec![0u8; 100])]);
        let err = extract_engine_exe(&archive, &dir.join("stage"), SMALL_LIMITS)
            .expect_err("a stub binary must be rejected");
        match err {
            FallbackError::ExeTooSmall { actual, floor } => {
                assert_eq!(actual, 100);
                assert_eq!(floor, SMALL_LIMITS.floor);
            }
            other => panic!("expected ExeTooSmall, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_archive_is_reported_as_unreadable() {
        let dir = temp_scope_dir("ex_garbage");
        let bogus = dir.join("garbage.7z");
        std::fs::write(&bogus, b"this is definitely not a 7z container").unwrap();
        let err = extract_engine_exe(&bogus, &dir.join("stage"), SMALL_LIMITS)
            .expect_err("garbage must be rejected");
        assert!(matches!(err, FallbackError::ArchiveUnreadable { .. }), "{err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_outside_staging_is_refused() {
        let staging = Path::new(r"C:\tmp\stage");
        let outside = Path::new(r"C:\tmp\stage\..\escape\mpv.exe");
        assert!(matches!(assert_within(staging, outside), Err(FallbackError::UnsafeEntry { .. })));
        assert!(assert_within(staging, &staging.join("mpv.exe")).is_ok());
    }
}
