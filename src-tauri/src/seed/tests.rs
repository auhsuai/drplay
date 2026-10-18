use super::*;
use std::io::Write;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "drplay_seed_{}_{}",
        std::process::id(),
        tag
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
    dir
}

fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            writer
                .start_file(*name, options)
                .expect("zip entry must be writable");
            writer.write_all(data).expect("zip entry bytes must be writable");
        }
        writer.finish().expect("zip must finish");
    }
    cursor.into_inner()
}

const META_JSON: &[u8] = br#"{"title":"Disk Title","artist":"Disk Artist","duration":180.5,"v":8,"coverOnDisk":true}"#;
const THUMB_JPG: &[u8] = b"thumb-jpeg-bytes";
const FULL_JPG: &[u8] = b"full-jpeg-bytes";

#[test]
fn import_valid_zip_writes_files_at_expected_paths() {
    let meta_root = temp_dir("valid_meta");
    let covers_root = temp_dir("valid_covers");
    let zip = make_zip(&[
        ("metadata/AbCdEf123456.json", META_JSON),
        ("metadata/zz99.json", META_JSON),
        ("covers/t/Ab/Cd/AbCdEf123456.jpg", THUMB_JPG),
        ("covers/f/Ab/Cd/AbCdEf123456.jpg", FULL_JPG),
    ]);
    let stats = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
        .expect("a valid seed must import");
    assert_eq!(
        stats,
        ImportStats {
            metadata_count: 2,
            cover_count: 2,
            skipped: 0,
        }
    );
    assert_eq!(
        std::fs::read(meta_root.join("AbCdEf123456.json")).expect("metadata must exist"),
        META_JSON
    );
    assert!(meta_root.join("zz99.json").exists());
    // Covers land EXACTLY where the drplay:// GET handler reads them —
    // cover_disk_path is the single path builder for reads AND imports.
    let thumb_path =
        cover::cover_disk_path(&covers_root, "AbCdEf123456", true).expect("valid id maps");
    assert_eq!(std::fs::read(&thumb_path).expect("thumb must exist"), THUMB_JPG);
    let full_path =
        cover::cover_disk_path(&covers_root, "AbCdEf123456", false).expect("valid id maps");
    assert_eq!(std::fs::read(&full_path).expect("full must exist"), FULL_JPG);
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

#[test]
fn import_rejects_zip_slip_entries() {
    let meta_root = temp_dir("slip_meta");
    let covers_root = temp_dir("slip_covers");
    for bad in [
        ("../evil.json", META_JSON),
        ("metadata/../evil.json", META_JSON),
        ("covers/../evil.jpg", THUMB_JPG),
    ] {
        let zip = make_zip(&[bad]);
        let err = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
            .expect_err("a traversal entry must reject the whole import");
        assert!(
            err.contains("unsafe zip entry") || err.contains("unexpected zip entry layout"),
            "unexpected error message: {err}"
        );
    }
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

#[test]
fn import_rejects_wrong_layout_entries() {
    let meta_root = temp_dir("layout_meta");
    let covers_root = temp_dir("layout_covers");
    for bad in [
        ("metadata/a/b.json", META_JSON),       // too deep
        ("covers/t/bad.jpg", THUMB_JPG),        // missing shard dirs
        ("covers/t/Ab/Cd/AbCdEf123456.png", b"x"), // wrong extension
        ("covers/x/Ab/Cd/AbCdEf123456.jpg", THUMB_JPG), // bad variant
        ("other/file.json", META_JSON),         // unknown prefix
    ] {
        let zip = make_zip(&[bad]);
        let err = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
            .expect_err("a layout-invalid entry must reject the whole import");
        assert!(
            err.contains("unexpected zip entry layout")
                || err.contains("cover variant must be")
                || err.contains("metadata entry must be")
                || err.contains("cover entry must be"),
            "unexpected error message: {err}"
        );
    }
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

#[test]
fn import_rejects_whole_zip_when_a_later_entry_is_invalid() {
    let meta_root = temp_dir("upfront_meta");
    let covers_root = temp_dir("upfront_covers");
    // Valid entry first, layout-invalid entry second: upfront validation
    // must reject the zip BEFORE the valid entry lands on disk.
    let zip = make_zip(&[
        ("metadata/AbCdEf123456.json", META_JSON),
        ("metadata/a/b.json", META_JSON),
    ]);
    let err = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
        .expect_err("an invalid entry must reject the whole import");
    assert!(
        err.contains("unexpected zip entry layout"),
        "unexpected error message: {err}"
    );
    assert!(
        !meta_root.join("AbCdEf123456.json").exists(),
        "the valid entry preceding the invalid one must NOT be written (upfront validation)"
    );
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

#[test]
fn import_rejects_invalid_file_ids() {
    let meta_root = temp_dir("fid_meta");
    let covers_root = temp_dir("fid_covers");
    for bad in [
        ("metadata/a b.json", META_JSON), // space in id
        ("metadata/..json", META_JSON),   // dots in id
        ("metadata/héllo.json", META_JSON), // non-ascii id
    ] {
        let zip = make_zip(&[bad]);
        let err = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
            .expect_err("an invalid file id must reject the whole import");
        assert!(
            err.contains("invalid file id"),
            "unexpected error message: {err}"
        );
    }
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

#[test]
fn import_rejects_mismatched_shard_dirs() {
    let meta_root = temp_dir("shard_meta");
    let covers_root = temp_dir("shard_covers");
    let zip = make_zip(&[("covers/t/zz/yy/AbCdEf123456.jpg", THUMB_JPG)]);
    let err = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
        .expect_err("mismatched shard dirs must reject the whole import");
    assert!(
        err.contains("do not match"),
        "unexpected error message: {err}"
    );
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

#[test]
fn import_skips_oversized_entries_but_imports_the_rest() {
    let meta_root = temp_dir("oversize_meta");
    let covers_root = temp_dir("oversize_covers");
    let huge = vec![0xABu8; METADATA_MAX_BYTES as usize + 16];
    let zip = make_zip(&[
        ("metadata/huge.json", &huge),
        ("covers/t/Ab/Cd/AbCdEf123456.jpg", THUMB_JPG),
    ]);
    let stats = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
        .expect("oversized entries are skipped, not fatal");
    assert_eq!(
        stats,
        ImportStats {
            metadata_count: 0,
            cover_count: 1,
            skipped: 1,
        }
    );
    assert!(
        !meta_root.join("huge.json").exists(),
        "oversized metadata must not be written"
    );
    assert!(
        cover::cover_disk_path(&covers_root, "AbCdEf123456", true)
            .expect("valid id maps")
            .exists(),
        "the valid cover must still be imported"
    );
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

#[test]
fn import_skips_directory_entries_silently() {
    let meta_root = temp_dir("dir_meta");
    let covers_root = temp_dir("dir_covers");
    // Python's zipfile (Colab) emits directory entries with a trailing '/'.
    let zip = make_zip(&[
        ("metadata/", b""),
        ("covers/", b""),
        ("covers/t/", b""),
    ]);
    let stats = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
        .expect("directory entries must be skipped, not fatal");
    assert_eq!(
        stats,
        ImportStats {
            metadata_count: 0,
            cover_count: 0,
            skipped: 0,
        }
    );
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

#[test]
fn import_overwrites_existing_metadata_and_covers() {
    let meta_root = temp_dir("overwrite_meta");
    let covers_root = temp_dir("overwrite_covers");
    std::fs::write(meta_root.join("AbCdEf123456.json"), b"stale").expect("fixture");
    let zip = make_zip(&[
        ("metadata/AbCdEf123456.json", META_JSON),
        ("covers/f/Ab/Cd/AbCdEf123456.jpg", FULL_JPG),
    ]);
    let stats = import_seed(std::io::Cursor::new(zip), &meta_root, &covers_root)
        .expect("re-import must succeed");
    assert_eq!(stats.metadata_count, 1);
    assert_eq!(
        std::fs::read(meta_root.join("AbCdEf123456.json")).expect("refreshed metadata"),
        META_JSON,
        "re-import refreshes the metadata (import again = refresh)"
    );
    let _ = std::fs::remove_dir_all(&meta_root);
    let _ = std::fs::remove_dir_all(&covers_root);
}

/// F3 (R05 fix-review): a FAILED import can still have written some covers
/// before failing (partial pass 2, see `import_seed` docs), so the cover
/// cache must be invalidated on EVERY outcome — not only on Ok. This drives
/// the command with a non-zip file (fails at open/parse) and asserts the
/// pre-seeded marker is gone afterwards.
#[tokio::test]
async fn failed_import_still_invalidates_cover_cache() {
    init_metadata_root(temp_dir("fail_import_meta"));
    cover::init_covers_root(temp_dir("fail_import_covers"));
    let probe_key = format!("seed_failed_import_probe_{}", std::process::id());
    // Any cached entry stands in for the NoCover marker (same cache, same
    // invalidate path) — the assertion is "cache cleared", not the sentinel.
    cover::COVER_CACHE
        .insert(probe_key.clone(), ("probe".to_string(), bytes::Bytes::new()))
        .await;
    assert!(
        cover::COVER_CACHE.get(&probe_key).await.is_some(),
        "fixture: probe marker must be cached"
    );

    let fixture_dir = temp_dir("fail_import_zip");
    let bad_zip = fixture_dir.join("not_a_zip.zip");
    std::fs::write(&bad_zip, b"definitely not a zip archive").expect("fixture file");
    let err = import_metadata_seed(bad_zip.to_string_lossy().into_owned())
        .await
        .expect_err("a non-zip file must fail the import");
    assert!(
        err.contains("failed to open zip archive"),
        "unexpected error: {err}"
    );
    assert!(
        cover::COVER_CACHE.get(&probe_key).await.is_none(),
        "the cover cache must be invalidated even when the import fails (partial writes are possible)"
    );
    let _ = std::fs::remove_dir_all(&fixture_dir);
}

#[test]
fn read_metadata_missing_file_is_none() {
    let root = temp_dir("read_missing");
    assert_eq!(
        read_metadata_from_disk(&root, "validid").expect("missing file is Ok(None)"),
        None
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn read_metadata_returns_exact_json_when_present() {
    let root = temp_dir("read_hit");
    std::fs::create_dir_all(&root).expect("fixture dir");
    std::fs::write(root.join("validid.json"), META_JSON).expect("fixture file");
    let got = read_metadata_from_disk(&root, "validid").expect("present file reads");
    assert_eq!(
        got,
        Some(String::from_utf8(META_JSON.to_vec()).expect("fixture is utf-8"))
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn read_metadata_rejects_invalid_file_ids() {
    let root = temp_dir("read_badid");
    assert!(read_metadata_from_disk(&root, "../evil").is_err());
    assert!(read_metadata_from_disk(&root, "a b").is_err());
    assert!(read_metadata_from_disk(&root, "").is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn read_metadata_errors_on_oversized_file() {
    let root = temp_dir("read_oversize");
    std::fs::create_dir_all(&root).expect("fixture dir");
    std::fs::write(
        root.join("big.json"),
        vec![0u8; METADATA_MAX_BYTES as usize + 8],
    )
    .expect("fixture file");
    assert!(
        read_metadata_from_disk(&root, "big").is_err(),
        "an oversized metadata file must surface as an IO error (caller falls through)"
    );
    let _ = std::fs::remove_dir_all(&root);
}
