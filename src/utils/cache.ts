import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { clearAllMetadataCache } from "./metadata";
import { captureError } from "./errorLog";

const METADATA_CACHE_PREFIX = "metadata_";
const METADATA_LRU_KEY = "__drplay_metadata_lru";

export async function clearAppCache(): Promise<void> {
  try {
    await db.metadataCache
      .where("key")
      .startsWith(METADATA_CACHE_PREFIX)
      .delete();
  } catch (e: unknown) {
    captureError({
      level: 'error',
      source: 'cache',
      message: `Failed to delete Dexie metadata cache: ${e instanceof Error ? e.message : String(e)}`,
    });
    throw e;
  } finally {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(METADATA_LRU_KEY);
    }
    try {
      await invoke("clear_local_cache");
      clearAllMetadataCache();
    } catch (e: unknown) {
      captureError({
        level: 'error',
        source: 'cache',
        message: `clear_local_cache failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}
