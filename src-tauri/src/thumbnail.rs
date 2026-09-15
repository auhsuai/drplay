use std::path::Path;

use std::io::Write;

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let tmp_path = parent.join(format!(
        ".tmp_{}_{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));

    // Any failure in the create/write/sync/rename chain must take the tmp file
    // with it — a partial write (disk full, permission) used to orphan a
    // `.tmp_{pid}_{uuid}` inside the shard dir.
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp_path, path)
    })();
    cleanup_on_err(&tmp_path, written).map_err(|e| e.to_string())
}

/// Removes `tmp` when `result` is an error (the tmp file belongs to this write
/// attempt only), passing the result through unchanged.
fn cleanup_on_err<T>(tmp: &Path, result: std::io::Result<T>) -> std::io::Result<T> {
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

/// Windows resolves these names to character devices regardless of extension
/// (`CON.json` ≡ `CON`), so a file created under one of them is not a regular
/// file. Real Drive ids are long — a 3-4 char id is never a legitimate track.
const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn validate_file_id(raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err("file_id is empty".into());
    }
    if raw.len() > 128 {
        return Err("file_id too long (max 128)".into());
    }
    if let Some((idx, bad)) = raw
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '-' || *c == '_'))
    {
        return Err(format!(
            "file_id contains invalid characters (len {}, first invalid at byte {}, char class {})",
            raw.len(),
            idx,
            classify_char(bad),
        ));
    }
    if RESERVED_DEVICE_NAMES
        .iter()
        .any(|reserved| raw.eq_ignore_ascii_case(reserved))
    {
        // No raw id in the message (error strings must not echo input).
        return Err("file_id is a Windows reserved device name".into());
    }
    Ok(())
}

fn classify_char(c: char) -> &'static str {
    if c.is_control() {
        "control"
    } else if c.is_whitespace() {
        "whitespace"
    } else if c.is_ascii_graphic() {
        "printable ascii"
    } else {
        "non-ascii"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "drplay_thumb_{}_{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
        dir
    }

    #[test]
    fn invalid_file_id_error_does_not_echo_raw_input() {
        let hostile = "abc<script>alert(1)</script>";
        let err = validate_file_id(hostile).unwrap_err();
        assert!(
            !err.contains("script") && !err.contains('<'),
            "error string must not echo raw input fragments, got: {err}"
        );
        assert!(err.contains("invalid characters"));
    }

    #[test]
    fn cleanup_on_err_removes_tmp_on_failure_and_keeps_it_on_success() {
        let dir = temp_test_dir("cleanup_helper");
        let tmp = dir.join("probe.tmp");
        std::fs::write(&tmp, b"x").expect("fixture file");
        let err: std::io::Result<()> =
            Err(std::io::Error::new(std::io::ErrorKind::Other, "boom"));
        assert!(cleanup_on_err(&tmp, err).is_err());
        assert!(!tmp.exists(), "tmp must be removed when the write chain fails");

        std::fs::write(&tmp, b"x").expect("fixture file");
        assert!(cleanup_on_err(&tmp, Ok(())).is_ok());
        assert!(tmp.exists(), "tmp must survive a successful write chain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_leaves_no_tmp_when_rename_fails() {
        let dir = temp_test_dir("rename_fail");
        // A directory at the destination makes the final rename fail; the tmp
        // file created by the write pass must not be orphaned in the parent.
        let dest = dir.join("dest_dir");
        std::fs::create_dir_all(&dest).expect("fixture dir");
        assert!(
            atomic_write(&dest, b"payload").is_err(),
            "renaming a file onto a directory must fail"
        );
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("fixture dir readable")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".tmp_"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no orphan .tmp_* may remain after a failed write, found: {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_file_id_rejects_reserved_device_names() {
        for reserved in ["CON", "nul", "COM1", "LPT9", "aux"] {
            assert!(
                validate_file_id(reserved).is_err(),
                "{reserved} must be rejected (Windows reserved device name)"
            );
        }
        for allowed in ["console", "CONX", "drive_1a2B-3c_4d"] {
            assert_eq!(
                validate_file_id(allowed),
                Ok(()),
                "{allowed} must stay valid"
            );
        }
    }

    #[test]
    fn validate_file_id_contract_unchanged() {
        assert_eq!(validate_file_id("drive_1a2B-3c_4d"), Ok(()));
        assert!(validate_file_id("").is_err());
        assert!(validate_file_id(&"x".repeat(129)).is_err());
    }
}
