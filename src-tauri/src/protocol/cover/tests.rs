use super::*;

/// Poison the global `IN_FLIGHT` mutex: a thread panics while holding the
/// lock. `join()` returns the panic as `Err` — expected and ignored; the
/// mutex stays poisoned for the rest of the process.
fn poison_in_flight() {
    let _ = std::thread::spawn(|| {
        let _guard = IN_FLIGHT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        panic!("intentional IN_FLIGHT poison for the poison-recovery tests");
    })
    .join();
}

#[tokio::test]
async fn cover_cache_stores_and_fetches_by_key() {
    let cache: Cache<String, (String, Bytes)> = Cache::builder()
        .max_capacity(1_000)
        .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
        .time_to_live(Duration::from_secs(60))
        .build();

    let key = cover_cache_key("abc123", true);
    assert!(cache.get(&key).await.is_none(), "fresh cache must miss");

    let payload = Bytes::from(vec![1u8, 2, 3, 4, 5]);
    cache.insert(key.clone(), ("\"etag\"".to_string(), payload.clone())).await;
    let got = cache.get(&key).await;
    assert!(got.is_some(), "inserted entry must be fetchable");
    assert_eq!(got.unwrap().1, payload);

    // Different thumb/full variant is a separate key.
    assert!(cache.get(&cover_cache_key("abc123", false)).await.is_none());
}

#[tokio::test]
async fn cover_cache_evicts_under_byte_capacity() {
    // Tiny capacity forces eviction once summed weights exceed the cap.
    let cache: Cache<String, (String, Bytes)> = Cache::builder()
        .max_capacity(10) // 10 bytes total
        .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
        .build();

    // Insert two 8-byte entries (16 bytes > 10 capacity).
    cache.insert("a".to_string(), ("e".to_string(), Bytes::from(vec![0u8; 8]))).await;
    cache.insert("b".to_string(), ("e".to_string(), Bytes::from(vec![1u8; 8]))).await;

    // Drain maintenance tasks so eviction is applied.
    cache.run_pending_tasks().await;

    // At most one 8-byte entry can remain under a 10-byte cap.
    let a = cache.get(&"a".to_string()).await;
    let b = cache.get(&"b".to_string()).await;
    let present = a.is_some() as u32 + b.is_some() as u32;
    assert!(present <= 1, "byte cap must evict down to <=1 entry, got {}", present);
}

#[tokio::test]
async fn waiters_capped_when_vec_at_cap() {
    const KEY_ID: &str = "cap_test";
    let key = cover_cache_key(KEY_ID, false);
    COVER_CACHE.invalidate(&key).await;
    lock_in_flight().remove(&key);

    // Simulate a leader that is still fetching: a waiter Vec already at
    // the cap, holding live senders so the Vec stays alive.
    lock_in_flight().insert(
        key.clone(),
        (0..MAX_WAITERS_PER_KEY).map(|_| oneshot::channel().0).collect(),
    );

    let task = tokio::spawn(async move {
        handle_cover_get(KEY_ID, false).await
    });

    // Poll: on the old unbounded code the request pushes a (cap+1)-th
    // waiter and blocks forever; on the capped code it self-serves and the
    // Vec is drained without ever exceeding the cap.
    let mut observed = 0usize;
    let mut beyond_cap = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let len = lock_in_flight().get(&key).map_or(0, Vec::len);
        observed = observed.max(len);
        if len > MAX_WAITERS_PER_KEY {
            beyond_cap = true;
            break;
        }
        if task.is_finished() {
            break;
        }
    }

    assert!(
        !beyond_cap,
        "waiter Vec for one cache_key grew to {observed}, exceeding cap {MAX_WAITERS_PER_KEY} \
         (unbounded IN_FLIGHT waiters bug)"
    );

    // Cleanup: drop the fake leader's entry so any still-waiting request is
    // woken (its oneshot sender is dropped -> Err -> retry -> self-serve).
    lock_in_flight().remove(&key);
    let finished = tokio::time::timeout(Duration::from_secs(5), task).await;
    assert!(finished.is_ok(), "request must not hang after the leader dies");
}

#[tokio::test]
async fn concurrent_requests_do_not_pile_up_waiters() {
    const KEY_ID: &str = "burst_test";
    let key = cover_cache_key(KEY_ID, false);
    COVER_CACHE.invalidate(&key).await;
    lock_in_flight().remove(&key);

    // Fake in-flight leader: an empty waiter Vec that no real fetch ever
    // resolves, so every request either waits (up to the cap) or self-serves.
    lock_in_flight().insert(key.clone(), Vec::new());

    let handles: Vec<_> = (0..256usize)
        .map(|_| {
            tokio::spawn(async move {
                handle_cover_get(KEY_ID, false).await
            })
        })
        .collect();

    // Wait for the burst to settle (all tasks reach the subscribe step;
    // waiters then either resolve or self-serve) and track the peak count.
    let mut max_len = 0usize;
    let mut last = usize::MAX;
    let mut stable = 0;
    for _ in 0..250 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let len = lock_in_flight().get(&key).map_or(0, Vec::len);
        max_len = max_len.max(len);
        if len == last {
            stable += 1;
        } else {
            stable = 0;
        }
        last = len;
        if stable >= 3 {
            break;
        }
    }

    assert!(
        max_len <= MAX_WAITERS_PER_KEY,
        "concurrent burst piled up {max_len} waiters for one key (cap {MAX_WAITERS_PER_KEY}) \
         — unbounded IN_FLIGHT waiters bug"
    );

    // Drop the fake leader so any still-waiting tasks wake up and finish.
    lock_in_flight().remove(&key);
    for h in handles {
        let _ = tokio::time::timeout(Duration::from_secs(5), h).await;
    }
}

// --- A16: a poisoned IN_FLIGHT must not break cover requests forever ----

/// A panic while `IN_FLIGHT` is locked poisons the mutex; every later
/// request used to panic at the same `unwrap()` until an app restart. With
/// the recovery policy the request must complete normally instead.
#[tokio::test]
async fn poisoned_in_flight_recovers_instead_of_panicking() {
    const KEY_ID: &str = "poison_recovery_test";
    let key = cover_cache_key(KEY_ID, false);
    COVER_CACHE.invalidate(&key).await;
    lock_in_flight().remove(&key);

    poison_in_flight();
    assert!(IN_FLIGHT.lock().is_err(), "fixture: IN_FLIGHT must be poisoned");

    // Pre-fix this panicked with PoisonError at the first IN_FLIGHT lock.
    let first = handle_cover_get(KEY_ID, false).await;
    assert!(first.is_err(), "an uncached id must resolve to an error, not panic: {first:?}");
    assert!(
        !lock_in_flight().contains_key(&key),
        "a completed request must leave no in-flight entry behind"
    );

    // And a second request after the poison must still be served.
    let second = handle_cover_get(KEY_ID, false).await;
    assert!(second.is_err(), "the request after poisoning must still be served: {second:?}");
}

/// The stale-waiter retry branch (rx Err -> re-assert leadership) also
/// locks IN_FLIGHT; it must recover from poisoning the same way.
#[tokio::test]
async fn poisoned_in_flight_stale_waiter_retry_recovers() {
    const KEY_ID: &str = "poison_retry_test";
    let key = cover_cache_key(KEY_ID, false);
    COVER_CACHE.invalidate(&key).await;

    poison_in_flight();
    assert!(IN_FLIGHT.lock().is_err(), "fixture: IN_FLIGHT must be poisoned");

    // Fake leader owns the key with an empty waiter Vec; the request under
    // test subscribes to it and parks.
    lock_in_flight().insert(key.clone(), Vec::new());
    let task = tokio::spawn(async move { handle_cover_get(KEY_ID, false).await });

    let mut queued = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        if lock_in_flight().get(&key).is_some_and(|waiters| waiters.len() == 1) {
            queued = true;
            break;
        }
        if task.is_finished() {
            break;
        }
    }
    assert!(queued, "fixture: the request must queue as a waiter of the fake leader");

    // Drop the fake leader: the parked request wakes with a channel error
    // and takes the IN_FLIGHT_RETRY branch (the third poison-sensitive lock
    // site) before self-serving.
    lock_in_flight().remove(&key);
    let result = task.await.expect("the retry branch must not panic on a poisoned mutex");
    assert!(result.is_err(), "the self-served request must resolve to an error: {result:?}");
    assert!(
        !lock_in_flight().contains_key(&key),
        "the retry branch must clean its entry up"
    );
}

/// `InFlightGuard::drop` is the last line of defense for IN_FLIGHT cleanup
/// (panic/cancellation); it must remove its entry even when the mutex is
/// poisoned, or the stale entry + its waiters would block the key forever.
#[test]
fn in_flight_guard_drop_cleans_up_under_poisoned_mutex() {
    let key = cover_cache_key("poison_guard_test", false);
    poison_in_flight();
    assert!(IN_FLIGHT.lock().is_err(), "fixture: IN_FLIGHT must be poisoned");

    lock_in_flight().insert(key.clone(), Vec::new());
    drop(InFlightGuard { cache_key: key.clone() });
    assert!(
        !lock_in_flight().contains_key(&key),
        "Drop must remove its entry even when the mutex is poisoned"
    );
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("drplay_cache_info_{}_{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
    dir
}

#[test]
fn directory_size_missing_path_is_zero() {
    let missing = std::env::temp_dir().join("drplay_cache_info_does_not_exist_anything");
    let _ = std::fs::remove_dir_all(&missing);
    assert_eq!(directory_size(&missing), 0, "nonexistent path must report 0");
    assert_eq!(directory_size(std::path::Path::new("Z:\\definitely\\no\\such\\path")), 0);
}

#[test]
fn directory_size_empty_dir_is_zero() {
    let dir = temp_dir("empty");
    assert_eq!(directory_size(&dir), 0, "empty dir must report 0");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn directory_size_sums_files_and_nested_dirs() {
    let dir = temp_dir("nested");
    let sub = dir.join("sub");
    std::fs::create_dir_all(&sub).expect("subdir must be creatable");
    std::fs::write(dir.join("a.bin"), vec![0u8; 100]).expect("file a must be writable");
    std::fs::write(dir.join("b.bin"), vec![0u8; 250]).expect("file b must be writable");
    std::fs::write(sub.join("c.bin"), vec![0u8; 50]).expect("file c must be writable");
    assert_eq!(directory_size(&dir), 400, "must sum all files recursively (100+250+50)");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn remove_dir_contents_clears_files_and_subdirs_keeps_dir() {
    let dir = temp_dir("clear");
    let sub = dir.join("sub");
    std::fs::create_dir_all(&sub).expect("subdir must be creatable");
    std::fs::write(dir.join("a.bin"), vec![0u8; 10]).expect("file a must be writable");
    std::fs::write(sub.join("b.bin"), vec![0u8; 20]).expect("file b must be writable");
    remove_dir_contents(&dir).expect("clearing must succeed");
    assert!(dir.is_dir(), "the directory itself must survive");
    assert!(!sub.exists(), "nested subdir must be removed");
    assert_eq!(
        std::fs::read_dir(&dir).expect("cleared dir must be readable").count(),
        0,
        "no entries may remain"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn remove_dir_contents_missing_path_is_ok() {
    let missing = std::env::temp_dir().join(format!(
        "drplay_cache_info_missing_clear_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&missing);
    assert!(remove_dir_contents(&missing).is_ok(), "nonexistent path must be Ok(())");
}

#[test]
fn remove_dir_contents_empty_dir_is_ok() {
    let dir = temp_dir("clear_empty");
    assert!(remove_dir_contents(&dir).is_ok(), "empty dir must be Ok(())");
    assert!(dir.is_dir(), "empty dir must survive");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn remove_dir_contents_file_path_removes_the_file() {
    let dir = temp_dir("clear_file");
    let file = dir.join("squatter.bin");
    std::fs::write(&file, vec![0u8; 5]).expect("file must be writable");
    remove_dir_contents(&file).expect("a regular file at the path must be removed");
    assert!(!file.exists(), "file squatting on the cache dir path must be gone");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(windows)]
#[test]
fn remove_dir_contents_does_not_follow_dir_symlinks() {
    let target = temp_dir("clear_symlink_target");
    let dir = temp_dir("clear_symlink");
    let link = dir.join("to_target");
    match std::os::windows::fs::symlink_dir(&target, &link) {
        Ok(()) => {
            remove_dir_contents(&dir).expect("clearing must succeed");
            assert!(!link.exists(), "the symlink itself must be removed");
            assert!(
                std::fs::read_dir(&target).expect("target must be readable").count() == 0,
                "target dir must exist untouched"
            );
        }
        Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
    }
    let _ = std::fs::remove_dir_all(&target);
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(not(windows))]
#[test]
fn remove_dir_contents_does_not_follow_dir_symlinks() {
    let target = temp_dir("clear_symlink_target");
    std::fs::write(target.join("keep.bin"), vec![0u8; 7]).expect("target file must be writable");
    let dir = temp_dir("clear_symlink");
    let link = dir.join("to_target");
    match std::os::unix::fs::symlink(&target, &link) {
        Ok(()) => {
            remove_dir_contents(&dir).expect("clearing must succeed");
            assert!(!link.exists(), "the symlink itself must be removed");
            assert!(
                target.join("keep.bin").exists(),
                "content behind the symlink must NOT be removed"
            );
        }
        Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
    }
    let _ = std::fs::remove_dir_all(&target);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn weighted_size_reports_zero_when_cache_empty() {
    let cache: Cache<String, (String, Bytes)> = Cache::builder()
        .max_capacity(10_000)
        .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
        .build();
    cache.run_pending_tasks().await;
    assert_eq!(cache.weighted_size(), 0, "empty cache must report 0 bytes");
    assert_eq!(cache.entry_count(), 0, "empty cache must report 0 entries");
}

#[tokio::test]
async fn weighted_size_tracks_inserted_bytes() {
    let cache: Cache<String, (String, Bytes)> = Cache::builder()
        .max_capacity(10_000)
        .weigher(|_k: &String, v: &(String, Bytes)| v.1.len() as u32)
        .build();
    cache.insert("a".to_string(), ("\"e\"".to_string(), Bytes::from(vec![0u8; 64]))).await;
    cache.insert("b".to_string(), ("\"e\"".to_string(), Bytes::from(vec![0u8; 36]))).await;
    cache.run_pending_tasks().await;
    assert_eq!(cache.weighted_size(), 100, "weighted_size must equal summed weigher weights (64+36)");
    cache.invalidate_all();
    cache.run_pending_tasks().await;
    assert_eq!(cache.weighted_size(), 0, "invalidate_all must drain weight to 0");
}

// ========================= S3 disk cache tests =========================

/// A fresh covers root per test (the `covers/` dir itself is created by
/// the code under test). Tagged with pid so parallel tests never collide.
fn s3_temp_root(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "drplay_s3_covers_{}_{}",
        std::process::id(),
        tag
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test fixture dir must be creatable");
    dir
}

fn s3_shard_path(root: &std::path::Path, raw_id: &str, thumb: bool) -> std::path::PathBuf {
    super::cover_disk_path(root, raw_id, thumb).expect("valid id must map to a path")
}

#[test]
fn s3_roundtrip_post_then_get_returns_exact_bytes() {
    let root = s3_temp_root("roundtrip");
    let id = "file_abc123";
    let payload: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
    let etag = write_cover_to_disk(&root, id, true, &payload).expect("post must succeed");
    let (got_etag, got) = read_cover_from_disk(&root, id, true).expect("get must succeed");
    assert_eq!(got.to_vec(), payload, "bytes must roundtrip exactly");
    assert_eq!(got_etag, etag, "etag must be stable across read");
    assert!(etag.starts_with('"') && etag.ends_with('"'), "etag must be quoted");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_roundtrip_full_variant_uses_f_subtree() {
    let root = s3_temp_root("roundtrip_full");
    let id = "file_xyz789";
    let payload = vec![0xABu8; 2048];
    write_cover_to_disk(&root, id, false, &payload).expect("full post must succeed");
    let (_, got) = read_cover_from_disk(&root, id, false).expect("full get must succeed");
    assert_eq!(got.to_vec(), payload);
    assert!(
        s3_shard_path(&root, id, false).starts_with(root.join("covers").join("f")),
        "full variant must live under covers/f"
    );
    assert!(
        !s3_shard_path(&root, id, true).exists(),
        "thumb variant must not be created by a full post"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_second_post_same_id_overwrites() {
    let root = s3_temp_root("overwrite");
    let id = "file_overwrite";
    write_cover_to_disk(&root, id, true, b"first-payload").expect("first post must succeed");
    write_cover_to_disk(&root, id, true, b"second-payload").expect("second post must succeed");
    let (_, got) = read_cover_from_disk(&root, id, true).expect("get must succeed");
    assert_eq!(
        got.to_vec(),
        b"second-payload",
        "atomic_write must replace the previous cover (std::fs::rename \
         MOVEFILE_REPLACE_EXISTING on Windows — verified by this test)"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_get_missing_file_is_nocover() {
    let root = s3_temp_root("missing");
    let err = read_cover_from_disk(&root, "file_never_posted", true).unwrap_err();
    assert!(
        matches!(err, CoverError::NoCover),
        "missing cover must map to NoCover, got {err:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_get_missing_root_dir_is_nocover() {
    let root = std::env::temp_dir().join(format!(
        "drplay_s3_covers_never_created_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let err = read_cover_from_disk(&root, "file_any", true).unwrap_err();
    assert!(
        matches!(err, CoverError::NoCover),
        "missing covers root must map to NoCover, got {err:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_build_path_uses_sharded_layout() {
    let root = std::path::Path::new("C:\\fake\\covers_root");
    let p = cover_disk_path(root, "AbCdEf123456", true).expect("valid id must map");
    assert_eq!(p, root.join("covers").join("t").join("Ab").join("Cd").join("AbCdEf123456.jpg"));
    let p_full = cover_disk_path(root, "AbCdEf123456", false).expect("valid id must map");
    assert_eq!(p_full, root.join("covers").join("f").join("Ab").join("Cd").join("AbCdEf123456.jpg"));
}

#[test]
fn s3_build_path_short_ids_use_xx_pad() {
    let root = std::path::Path::new("C:\\fake\\covers_root");
    let p = cover_disk_path(root, "Ab", true).expect("2-char id must map");
    assert_eq!(p, root.join("covers").join("t").join("Ab").join("xx").join("Ab.jpg"));
    let p_single = cover_disk_path(root, "Z", true).expect("1-char id must map");
    assert_eq!(p_single, root.join("covers").join("t").join("Z").join("xx").join("Z.jpg"));
}

#[test]
fn s3_build_path_rejects_invalid_ids() {
    let root = std::path::Path::new("C:\\fake\\covers_root");
    for bad in ["", "..\\evil", "a/b", "a b", "x".repeat(129).as_str(), "héllo"] {
        assert!(
            cover_disk_path(root, bad, true).is_err(),
            "id {bad:?} must be rejected by the path builder"
        );
    }
}

#[test]
fn s3_containment_rejects_path_outside_root() {
    let root = s3_temp_root("containment");
    let outside = std::env::temp_dir().join(format!(
        "drplay_s3_outside_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&outside).expect("outside fixture dir must be creatable");
    let outside_file = outside.join("secret.jpg");
    std::fs::write(&outside_file, b"secret").expect("outside file must be writable");
    let canon_outside = std::fs::canonicalize(&outside_file).expect("outside file must canonicalize");
    let canon_root = std::fs::canonicalize(&root).expect("root must canonicalize");
    assert!(
        !is_within_covers_root(&canon_outside, &canon_root),
        "path outside covers root must be refused"
    );
    // The direct builder must never produce a path outside root for any
    // valid id — traversal is blocked at validate_file_id.
    let crafted = cover_disk_path(&root, "..", true);
    assert!(crafted.is_err(), "'..' must fail validation before path building");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
}

#[cfg(windows)]
#[test]
fn s3_containment_rejects_symlink_escape() {
    let root = s3_temp_root("symlink_escape");
    let outside = std::env::temp_dir().join(format!(
        "drplay_s3_symlink_target_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&outside).expect("outside fixture dir must be creatable");
    let outside_file = outside.join("secret.jpg");
    std::fs::write(&outside_file, b"TOP-SECRET").expect("outside file must be writable");
    // Plant a symlink at exactly the path a real cover would occupy,
    // pointing outside the root.
    let link = s3_shard_path(&root, "file_symlink", true);
    std::fs::create_dir_all(link.parent().expect("shard dir")).expect("shard dirs");
    match std::os::windows::fs::symlink_file(&outside_file, &link) {
        Ok(()) => {
            let err = read_cover_from_disk(&root, "file_symlink", true).unwrap_err();
            assert!(
                matches!(err, CoverError::DiskRead(_)),
                "symlink escaping the root must be refused, got {err:?}"
            );
        }
        Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
    }
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
}

#[cfg(not(windows))]
#[test]
fn s3_containment_rejects_symlink_escape() {
    let root = s3_temp_root("symlink_escape");
    let outside = std::env::temp_dir().join(format!(
        "drplay_s3_symlink_target_{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&outside).expect("outside fixture dir must be creatable");
    let outside_file = outside.join("secret.jpg");
    std::fs::write(&outside_file, b"TOP-SECRET").expect("outside file must be writable");
    let link = s3_shard_path(&root, "file_symlink", true);
    std::fs::create_dir_all(link.parent().expect("shard dir")).expect("shard dirs");
    match std::os::unix::fs::symlink(&outside_file, &link) {
        Ok(()) => {
            let err = read_cover_from_disk(&root, "file_symlink", true).unwrap_err();
            assert!(
                matches!(err, CoverError::DiskRead(_)),
                "symlink escaping the root must be refused, got {err:?}"
            );
        }
        Err(e) => eprintln!("skipping symlink test (no privilege): {e}"),
    }
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);
}

#[test]
fn s3_gc_deletes_size_zero_corrupt_files() {
    let root = s3_temp_root("gc_zero");
    let id = "file_corrupt";
    let path = s3_shard_path(&root, id, true);
    std::fs::create_dir_all(path.parent().expect("shard dir")).expect("shard dirs");
    std::fs::write(&path, b"").expect("0-byte file must be writable");
    gc_covers(&root).expect("gc must succeed");
    assert!(!path.exists(), "0-byte corrupt cover must be deleted");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_gc_keeps_files_under_budget() {
    let root = s3_temp_root("gc_keep");
    let id = "file_keep";
    write_cover_to_disk(&root, id, true, &vec![0x01u8; 512]).expect("post must succeed");
    gc_covers(&root).expect("gc must succeed");
    let (_, got) = read_cover_from_disk(&root, id, true).expect("cover must survive");
    assert_eq!(got.len(), 512, "under-budget covers must survive gc");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_gc_enforces_budget_across_deep_dirs() {
    let root = s3_temp_root("gc_budget");
    // 8 covers × 100 B = 800 B total in the t subtree, 2 levels deep
    // ({s1}/{s2}) — GC must descend and evict oldest-first until the
    // 250 B budget is satisfied (≤ 3 files remain).
    for i in 0..8u32 {
        let id = format!("file_b{i:02}");
        write_cover_to_disk(&root, &id, true, &[i as u8; 100]).expect("post must succeed");
        std::thread::sleep(Duration::from_millis(15)); // distinct mtimes
    }
    gc_covers_with_budgets(&root, 250, u64::MAX).expect("gc must succeed");
    let mut sizes: Vec<(PathBuf, u64, u64)> = Vec::new();
    collect_cover_files(&root.join("covers").join("t"), &mut sizes);
    let total: u64 = sizes.iter().map(|(_, s, _)| s).sum();
    assert!(total <= 250, "thumb budget must be enforced, total was {total}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_gc_removes_empty_shard_dirs() {
    let root = s3_temp_root("gc_dirs");
    let id = "file_dirprune";
    write_cover_to_disk(&root, id, true, &[0x04u8; 64]).expect("post must succeed");
    let path = s3_shard_path(&root, id, true);
    std::fs::remove_file(&path).expect("fixture file must be removable");
    gc_covers(&root).expect("gc must succeed");
    let shard_dir = path.parent().expect("shard dir");
    assert!(
        !shard_dir.exists(),
        "empty shard dir must be pruned after gc"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_directory_size_reflects_disk_after_post() {
    let root = s3_temp_root("sizeinfo");
    write_cover_to_disk(&root, "file_size_a", true, &[0x05u8; 100]).expect("post must succeed");
    write_cover_to_disk(&root, "file_size_b", false, &vec![0x06u8; 250]).expect("post must succeed");
    let size = directory_size(&root);
    assert_eq!(size, 350, "directory_size must sum both variants (100+250)");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_clear_removes_contents_keeps_root_dir() {
    let root = s3_temp_root("clear");
    write_cover_to_disk(&root, "file_clr_a", true, b"data-a").expect("post must succeed");
    write_cover_to_disk(&root, "file_clr_b", false, b"data-b").expect("post must succeed");
    let covers_dir = root.join("covers");
    remove_dir_contents(&covers_dir).expect("clearing must succeed");
    assert!(covers_dir.is_dir(), "covers dir itself must survive");
    assert_eq!(
        std::fs::read_dir(&covers_dir).expect("covers dir must be readable").count(),
        0,
        "no cover entries may remain"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_get_cache_info_size_matches_disk() {
    let root = s3_temp_root("cacheinfo");
    write_cover_to_disk(&root, "file_ci", true, &vec![0x07u8; 777]).expect("post must succeed");
    assert_eq!(directory_size(&root.join("covers")), 777, "covers dir must reflect the post");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn s3_etag_changes_when_cover_rewritten() {
    let root = s3_temp_root("etag");
    let id = "file_etag";
    let etag1 = write_cover_to_disk(&root, id, true, b"v1").expect("post must succeed");
    std::thread::sleep(Duration::from_millis(1100)); // mtime granularity is seconds
    let etag2 = write_cover_to_disk(&root, id, true, b"v2").expect("post must succeed");
    assert_ne!(etag1, etag2, "rewritten cover must get a fresh etag");
    let _ = std::fs::remove_dir_all(&root);
}

/// Creates a directory link (symlink, with an NTFS junction fallback on
/// Windows where `symlink_dir` needs a privilege that is often absent) at
/// `link` pointing to `target`. Returns false when the platform refuses —
/// callers skip, same policy as the existing symlink tests.
#[cfg(windows)]
fn create_dir_link(target: &std::path::Path, link: &std::path::Path) -> bool {
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return true;
    }
    std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn create_dir_link(target: &std::path::Path, link: &std::path::Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

// R03-1: canonicalize can fail for reasons other than a clean miss
// (reparse loops, permission denied, transient sharing violations). Only
// NotFound means "no cover"; every other IO error must surface as
// DiskRead (HTTP 500, logged + retried) instead of being cached as a
// 1-hour NoCover marker.
#[test]
fn s3_canonicalize_loop_error_is_diskread_not_nocover() {
    let root = s3_temp_root("canon_loop");
    let shard_dir = root.join("covers").join("t");
    std::fs::create_dir_all(root.join("covers")).expect("covers dir must be creatable");
    // A self-referential directory link makes canonicalize fail with a
    // reparse-loop IO error (FilesystemLoop), NOT NotFound.
    if !create_dir_link(&shard_dir, &shard_dir) {
        eprintln!("skipping: cannot create a directory link on this machine");
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    let err = read_cover_from_disk(&root, "file_loop", true)
        .expect_err("a reparse-loop failure must not be reported as NoCover");
    assert!(
        matches!(err, CoverError::DiskRead(_)),
        "non-NotFound canonicalize failure must map to DiskRead, got {err:?}"
    );
    let _ = std::fs::remove_dir(&shard_dir);
    let _ = std::fs::remove_dir_all(&root);
}

// R03-2: GC/prune must never follow directory links out of the covers
// tree (same "never follow" invariant as `directory_size` and
// `remove_dir_contents`). A link squatting on a shard dir is skipped
// entirely: nothing behind it is evicted or pruned, however tight the
// budget.
#[test]
fn s3_gc_does_not_follow_dir_links_in_shard_dir() {
    let root = s3_temp_root("gc_dirlink");
    let target = temp_dir("gc_dirlink_target");
    std::fs::write(target.join("keep.jpg"), vec![0x11u8; 4096])
        .expect("target cover file must be writable");
    let keep_dir = target.join("keep_dir");
    std::fs::create_dir_all(&keep_dir).expect("target subdir must be creatable");

    let shard_dir = root.join("covers").join("t");
    std::fs::create_dir_all(root.join("covers")).expect("covers dir must be creatable");
    if !create_dir_link(&target, &shard_dir) {
        eprintln!("skipping: cannot create a directory link on this machine");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&target);
        return;
    }

    // A 1-byte budget forces eviction if (and only if) the walk follows
    // the link and counts the target's files as covers to police.
    gc_covers_with_budgets(&root, 1, u64::MAX).expect("gc must succeed");

    assert!(
        target.join("keep.jpg").exists(),
        "GC must not evict files behind a directory link squatting on a shard dir"
    );
    assert!(
        keep_dir.exists(),
        "prune must not descend through a directory link into the target"
    );
    let _ = std::fs::remove_dir(&shard_dir);
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&target);
}
