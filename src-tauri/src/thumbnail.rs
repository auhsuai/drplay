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

    {
        let mut f = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        f.write_all(data).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }

    std::fs::rename(&tmp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    Ok(())
}

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
    fn validate_file_id_contract_unchanged() {
        assert_eq!(validate_file_id("drive_1a2B-3c_4d"), Ok(()));
        assert!(validate_file_id("").is_err());
        assert!(validate_file_id(&"x".repeat(129)).is_err());
    }
}
