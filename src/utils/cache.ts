import { keys, delMany } from "idb-keyval";
import { invoke } from "@tauri-apps/api/core";

const METADATA_CACHE_PREFIX = "metadata_";
const METADATA_LRU_KEY = "__drplay_metadata_lru";

function isCacheKey(key: unknown): boolean {
  return (
    typeof key === "string" &&
    (key.startsWith(METADATA_CACHE_PREFIX) || key === METADATA_LRU_KEY)
  );
}

export async function clearAppCache(): Promise<void> {
  try {
    const allKeys = await keys();
    const cacheKeys = allKeys.filter(isCacheKey);
    if (cacheKeys.length > 0) {
      await delMany(cacheKeys);
    }
  } catch (e) {
    console.error(
      "[clearAppCache] failed to read/delete idb metadata cache",
      e instanceof Error ? e.message : String(e)
    );
    throw e;
  } finally {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(METADATA_LRU_KEY);
    }
    try {
      await invoke("clear_local_cache");
    } catch (e) {
      console.error(
        "[clearAppCache] invoke clear_local_cache failed",
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}
