import { invoke } from "@tauri-apps/api/core";

// NOTE (orchestrator, closed-loop audit): this function used to also delete
// from a Dexie `metadataCache` table and remove a `__drplay_metadata_lru`
// localStorage key. Both were confirmed dead — nothing in the app writes to
// either anymore (the old R2/SQLite tag-cache pipeline that populated them
// was removed) — so those two steps were deleted as no-ops-on-empty-data.
// What's LEFT below (`invoke("clear_local_cache")`) is itself a documented
// no-op on the Rust side today (see `clear_local_cache` in src-tauri/src/
// lib.rs) — kept only so the exported call sites don't need to special-case
// its absence. Net effect: as things stand, `clearAppCache()` currently does
// not free any real storage. Flagged to the user rather than silently
// removing the Settings "Clear Cache" button/feature that calls this.
export async function clearAppCache(): Promise<void> {
  try {
    await invoke("clear_local_cache");
  } catch (e) {
    console.error(
      "[clearAppCache] invoke clear_local_cache failed",
      e instanceof Error ? e.message : String(e)
    );
    throw e;
  }
}
