import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { clearAllMetadataCache } from "./metadata";
import { captureError } from "./errorLog";

const METADATA_CACHE_PREFIX = "metadata_";
const METADATA_LRU_KEY = "__drplay_metadata_lru";

export async function clearAppCache(): Promise<void> {
  let error: unknown = null;
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
    error = e;
  } finally {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(METADATA_LRU_KEY);
    }
    try {
      await invoke("clear_local_cache");
      clearAllMetadataCache();
    } catch (invokeErr: unknown) {
      if (!error) {
        captureError({
          level: 'error',
          source: 'cache',
          message: `clear_local_cache failed: ${invokeErr instanceof Error ? invokeErr.message : String(invokeErr)}`,
        });
        error = invokeErr;
      } else {
        captureError({
          level: 'error',
          source: 'cache',
          message: `clear_local_cache also failed: ${invokeErr instanceof Error ? invokeErr.message : String(invokeErr)}`,
        });
      }
    }
  }
  if (error) throw error;
}
