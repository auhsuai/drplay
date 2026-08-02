import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { clearAllMetadataCache, METADATA_KEY_PREFIX, METADATA_LRU_KEY } from "./metadata";
import { captureError } from "./errorLog";

export const CLEAR_LOCAL_CACHE_CMD = 'clear_local_cache';

export async function clearAppCache(): Promise<void> {
  let error: unknown = null;
  try {
    await db.metadataCache
      .where("key")
      .startsWith(METADATA_KEY_PREFIX)
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
      try {
        localStorage.removeItem(METADATA_LRU_KEY);
      } catch (removeErr: unknown) {
        captureError({
          level: 'warn',
          source: 'cache',
          message: `clear-lru-key-failed: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
        });
      }
    }
    try {
      await invoke(CLEAR_LOCAL_CACHE_CMD);
      try {
        clearAllMetadataCache();
      } catch (metaErr: unknown) {
        captureError({
          level: 'error',
          source: 'cache',
          message: `clear-memory-metadata-cache failed: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`,
        });
        if (!error) error = metaErr;
      }
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
