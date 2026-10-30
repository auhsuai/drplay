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
            // Pass 1 already validated this name from the header; validating it
            // again here keeps the invariant at the point where we actually
            // touch the stream.
            if let Err(err) = validate_entry_path(&entry.name) {
                write_error = Some(err);
                return Ok(false);
            }
            // SOLID archives: one compressed block holds many files
            // concatenated, and sevenz-rust2 hands each entry a bounded view
            // over the SAME block reader. Its own documentation warns: "When
            // decoding files in a block, the data to be decompressed depends on
            // the data in front of it, you cannot simply skip the previous data
            // and only decompress the data in the back." Returning `Ok(true)`
            // without reading therefore leaves the block reader at the wrong
            // offset, and the NEXT entry is decoded from the wrong bytes (its
            // CRC check then fails). Draining the skipped entry is what
            // advances the block reader correctly -- it is mandatory, not an
            // optimisation.
            if let Err(err) = io::copy(data, &mut io::sink()) {
                write_error = Some(FallbackError::ArchiveUnreadable {
                    detail: format!(
                        "draining a skipped archive entry failed: {}",
                        read_failure_class(&err)
                    ),
                });
                return Ok(false);
            }
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
                    detail: format!("the archive stream failed: {}", read_failure_class(&e)),
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

/// Describes a failure that happened while READING decoded archive data.
///
/// This is deliberately more specific than [`io_kind`]: a solid-block desync or
/// a truncated payload surfaces as a per-entry CRC mismatch inside
/// sevenz-rust2's `Crc32VerifyingReader`, which wraps
/// `Error::ChecksumVerificationFailed` in an `io::Error` (kind `Other`). That
/// used to collapse to a bare "I/O error" and made an archive-integrity bug
/// look like a filesystem problem. The `ErrorKind` and the decoder's own class
/// are both reported; no blobs, names, or paths are included.
fn read_failure_class(err: &io::Error) -> String {
    let kind = format!("{:?}", err.kind());
    if let Some(cause) = err.get_ref() {
        if let Some(sevenz_err) = cause.downcast_ref::<sevenz_rust2::Error>() {
            if matches!(sevenz_err, sevenz_rust2::Error::ChecksumVerificationFailed) {
                return format!(
                    "{kind} (per-entry CRC mismatch while decoding archive data: the decompressed \
                     bytes did not match what the archive recorded)"
                );
            }
            return format!("{kind} (archive decoder: {})", describe_archive_error(sevenz_err));
        }
    }
    if err.kind() == io::ErrorKind::InvalidData {
        return format!("{kind} (archive data did not match its recorded checksum)");
    }
    kind
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

    /// Builds a SINGLE-BLOCK ("solid") archive: every entry is concatenated
    /// into one compressed block, which is exactly the shape of the real
    /// upstream mpv archive. `push_archive_entry` (used by `build_archive`)
    /// emits one block per file, so it can never reproduce the solid-block
    /// desync bug.
    fn build_solid_archive(
        dir: &Path,
        entries: &[(&str, Vec<u8>)],
        method: sevenz_rust2::EncoderMethod,
    ) -> PathBuf {
        let path = dir.join("fixture-solid.7z");
        let mut writer = sevenz_rust2::ArchiveWriter::create(&path).expect("create 7z writer");
        writer.set_content_methods(vec![method.into()]);
        let mut metas = Vec::with_capacity(entries.len());
        let mut readers = Vec::with_capacity(entries.len());
        for (name, body) in entries {
            metas.push(sevenz_rust2::ArchiveEntry::new_file(name));
            readers.push(sevenz_rust2::SourceReader::new(io::Cursor::new(body.clone())));
        }
        writer.push_archive_entries(metas, readers).expect("push solid block");
        writer.finish().expect("finish 7z archive");
        path
    }

    fn assert_solid(path: &Path) {
        let reader = ArchiveReader::open(path, sevenz_rust2::Password::empty()).expect("open fixture");
        assert!(
            reader.archive().is_solid,
            "the fixture MUST be solid, otherwise it cannot reproduce the desync bug"
        );
    }

    /// Flips one bit inside the first on-disk occurrence of `marker`.
    ///
    /// Only meaningful with the COPY method: the entry bytes then appear
    /// verbatim in the packed stream, so the marker locates the exact byte to
    /// corrupt without hard-coding any 7z layout constant.
    fn corrupt_marker(path: &Path, marker: &[u8]) {
        let mut bytes = std::fs::read(path).expect("read fixture");
        let at = bytes
            .windows(marker.len())
            .position(|w| w == marker)
            .expect("marker must be visible in a COPY-packed archive");
        bytes[at] ^= 0xFF;
        std::fs::write(path, &bytes).expect("write corrupted fixture");
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

    /// REGRESSION: a solid block holds many files inside ONE compressed
    /// stream. Returning `Ok(true)` for a skipped entry without draining it
    /// leaves the shared block reader at the wrong offset, so the target is
    /// decoded from the wrong bytes and its CRC check fails. The real upstream
    /// archive is solid; the per-file fixtures above are not, which is why this
    /// needs its own fixture.
    #[test]
    fn extracts_the_engine_entry_from_a_solid_archive_with_siblings_before_it() {
        let dir = temp_scope_dir("ex_solid");
        // Distinctive, non-repeating siblings so a desync would be visible.
        let aaa: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let bbb: Vec<u8> = (0..6144u32).map(|i| (255 - (i % 241)) as u8).collect();
        let payload: Vec<u8> = (0..8192u32).map(|i| (i % 199) as u8).collect();

        let archive = build_solid_archive(
            &dir,
            &[
                ("aaa.txt", aaa.clone()),
                ("bbb.txt", bbb.clone()),
                ("mpv.exe", payload.clone()),
            ],
            sevenz_rust2::EncoderMethod::LZMA2,
        );
        assert_solid(&archive);

        let staging = dir.join("stage");
        let extracted = extract_engine_exe(&archive, &staging, SMALL_LIMITS).expect(
            "a solid archive whose target follows other entries must extract cleanly \
             (the skipped entries must be drained)",
        );
        assert_eq!(extracted.size, payload.len() as u64);
        assert_eq!(
            std::fs::read(&extracted.path).unwrap(),
            payload,
            "the extracted bytes must be the target entry, not a shifted window of a sibling"
        );

        // Only the target is materialised: the siblings are decoded (drained)
        // but never written anywhere.
        assert!(!staging.join("aaa.txt").exists(), "sibling aaa.txt must not be written");
        assert!(!staging.join("bbb.txt").exists(), "sibling bbb.txt must not be written");
        let staged: Vec<String> = std::fs::read_dir(&staging)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(staged, vec![String::from("mpv.exe")], "the staging dir must hold only the engine");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Same shape, but the sibling content is unrelated and large relative to
    /// the target: proves the drain is by byte count, not by "first N bytes".
    #[test]
    fn solid_archive_with_irrelevant_sibling_content_still_yields_the_target() {
        let dir = temp_scope_dir("ex_solid_irrelevant");
        let junk: Vec<u8> = (0..64 * 1024u32).map(|i| (i % 7) as u8).collect();
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 13) as u8).collect();

        let archive = build_solid_archive(
            &dir,
            &[("noise.bin", junk), ("mpv.exe", payload.clone())],
            sevenz_rust2::EncoderMethod::LZMA2,
        );
        assert_solid(&archive);

        let extracted = extract_engine_exe(&archive, &dir.join("stage"), SMALL_LIMITS)
            .expect("64 KiB of skipped solid data must be drained, not skipped");
        assert_eq!(extracted.size, payload.len() as u64);
        assert_eq!(std::fs::read(&extracted.path).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A corrupted member inside a solid block surfaces as a per-entry CRC
    /// mismatch from `Crc32VerifyingReader` -- an `io::Error`, NOT a
    /// filesystem failure. The detail must say so instead of "I/O error".
    #[test]
    fn solid_archive_corruption_reports_the_read_failure_class_not_a_bare_io_error() {
        let dir = temp_scope_dir("ex_solid_crc");

        // Both read paths are exercised: the corrupt region is placed in the
        // SKIPPED entry (failure while draining) and, separately, in the TARGET
        // entry (failure inside `write_entry`). COPY keeps the entry bytes
        // verbatim in the packed stream, so the markers below can be located
        // and flipped without knowing any 7z layout constant.
        let sibling: Vec<u8> =
            (0..8192u32).map(|i| if i < 64 { 0x33 } else { (i % 97) as u8 }).collect();
        let payload: Vec<u8> =
            (0..4096u32).map(|i| if i < 64 { 0x77 } else { (i % 89) as u8 }).collect();

        let cases: [(&str, u8, &str); 2] = [
            ("skipped entry", 0x33, "draining"),
            ("target entry", 0x77, "archive stream"),
        ];

        for (label, marker_byte, expected_stage) in cases {
            let case_dir = dir.join(label.replace(' ', "_"));
            std::fs::create_dir_all(&case_dir).unwrap();
            let archive = build_solid_archive(
                &case_dir,
                &[("aaa.txt", sibling.clone()), ("mpv.exe", payload.clone())],
                sevenz_rust2::EncoderMethod::COPY,
            );
            assert_solid(&archive);
            corrupt_marker(&archive, &vec![marker_byte; 64]);

            let err = extract_engine_exe(&archive, &case_dir.join("stage"), SMALL_LIMITS)
                .expect_err("a corrupted solid block must not extract silently");

            let FallbackError::ArchiveUnreadable { detail } = &err else {
                panic!("[{label}] expected ArchiveUnreadable, got {err:?}");
            };
            assert_ne!(
                detail, "I/O error",
                "[{label}] a desync/CRC failure must not read as a bare I/O error"
            );
            assert!(
                detail.contains(expected_stage),
                "[{label}] the detail must say which read failed, expected {expected_stage:?}: \
                 {detail}"
            );
            assert!(
                detail.contains("CRC") || detail.contains("Checksum") || detail.contains("checksum"),
                "[{label}] the detail must name the checksum/desync class: {detail}"
            );
            assert!(
                !detail.to_lowercase().contains("permission denied")
                    && !detail.to_lowercase().contains("path not found"),
                "[{label}] a CRC failure must not be attributed to the filesystem: {detail}"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The detail formatter itself, driven directly: an `io::Error` wrapping
    /// the crate's checksum error is classified as a checksum failure, and a
    /// plain transport error keeps its `ErrorKind`.
    #[test]
    fn read_failure_class_names_the_crc_class_and_the_error_kind() {
        let crc = io::Error::other(sevenz_rust2::Error::ChecksumVerificationFailed);
        let text = read_failure_class(&crc);
        assert!(text.contains("CRC"), "{text}");
        assert!(text.contains(format!("{:?}", io::ErrorKind::Other).as_str()), "{text}");
        assert!(!text.contains("I/O error"), "{text}");

        let invalid = io::Error::new(io::ErrorKind::InvalidData, "checksum mismatch");
        let text = read_failure_class(&invalid);
        assert!(text.contains("InvalidData"), "{text}");
        assert!(text.contains("checksum"), "{text}");

        let eof = io::Error::new(io::ErrorKind::UnexpectedEof, "short");
        let text = read_failure_class(&eof);
        assert!(text.contains("UnexpectedEof"), "{text}");
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
