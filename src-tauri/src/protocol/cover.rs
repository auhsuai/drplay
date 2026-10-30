mod cache;
mod disk;
mod handlers;

pub use cache::{CoverError, COVER_CACHE};
pub use disk::{directory_size, init_covers_root, remove_dir_contents, spawn_covers_gc};
pub use handlers::{
    clear_local_cache, clear_thumbnail_dir, get_cache_info, handle_cover_get, handle_cover_post,
    CacheInfo,
};

#[cfg(test)]
pub(crate) use disk::cover_disk_path;

#[cfg(test)]
use moka::future::Cache;
#[cfg(test)]
use bytes::Bytes;
#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use std::time::Duration;
#[cfg(test)]
use tokio::sync::oneshot;

#[cfg(test)]
use cache::{cover_cache_key, lock_in_flight, InFlightGuard, IN_FLIGHT, MAX_WAITERS_PER_KEY};
#[cfg(test)]
use disk::{
    collect_cover_files, gc_covers, gc_covers_with_budgets, is_within_covers_root,
    read_cover_from_disk, write_cover_to_disk,
};

#[cfg(test)]
mod tests;
