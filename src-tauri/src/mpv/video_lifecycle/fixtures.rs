use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

pub(super) fn fixture(name: &str) -> PathBuf {
    let dir = std::env::var("DRPLAY_VIDEO_FIXTURES").unwrap_or_else(|_| {
        panic!("DRPLAY_VIDEO_FIXTURES must point at the fixture directory (probe.mkv, large.mkv, ...)")
    });
    let path = PathBuf::from(dir).join(name);
    assert!(
        path.is_file(),
        "fixture {name} is missing at {} — generate it first",
        path.display()
    );
    path
}
