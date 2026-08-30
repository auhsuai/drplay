import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import {
  clearAllMetadataCache,
  METADATA_KEY_PREFIX,
  METADATA_LRU_KEY,
} from "./metadata";
import { captureError } from "./errorLog";
import {
  clearPrefetchedStreams,
  getPrefetchedStreamCount,
} from "./streamPrefetcher";

export const CLEAR_LOCAL_CACHE_CMD = "clear_local_cache";
export const CLEAR_THUMBNAIL_DIR_CMD = "clear_thumbnail_dir";
export const GET_CACHE_INFO_CMD = "get_cache_info";

export type CacheCategoryId = "metadata" | "files" | "covers" | "prefetch";

// Single source of truth for category display names — the UI renders rows
// from this map while getCacheSizes uses the same labels for its results.
export const CACHE_CATEGORY_LABELS: Record<CacheCategoryId, string> = {
  metadata: "Metadata cache",
  files: "File listing cache",
  covers: "Covers & thumbnails",
  prefetch: "Prefetched data",
};

export interface CacheCategoryInfo {
  id: CacheCategoryId;
  label: string;
  bytes: number;
}

// Estimated bytes per db.files row: id + name + parentId + mimeType plus the
// optional size/modifiedTime strings and Dexie record overhead. count() runs
// on the primary-key index, so we never materialize the whole table.
export const FILES_ROW_ESTIMATED_BYTES = 200;

// Estimated bytes per prefetch entry: a /drive-stream/ URL string (~30 chars)
// plus Map entry overhead. streamPrefetcher stores only URL strings.
export const PREFETCH_ENTRY_ESTIMATED_BYTES = 128;

const ALL_CACHE_CATEGORIES: CacheCategoryId[] = [
  "metadata",
  "files",
  "covers",
  "prefetch",
];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function getCacheSizes(): Promise<CacheCategoryInfo[]> {
  const [metadataBytes, filesBytes, coversBytes, prefetchBytes] = [
    await estimateMetadataBytes(),
    await estimateFilesBytes(),
    await estimateCoversBytes(),
    estimatePrefetchBytes(),
  ];
  return [
    {
      id: "metadata",
      label: CACHE_CATEGORY_LABELS.metadata,
      bytes: metadataBytes,
    },
    { id: "files", label: CACHE_CATEGORY_LABELS.files, bytes: filesBytes },
    { id: "covers", label: CACHE_CATEGORY_LABELS.covers, bytes: coversBytes },
    {
      id: "prefetch",
      label: CACHE_CATEGORY_LABELS.prefetch,
      bytes: prefetchBytes,
    },
  ];
}

async function estimateMetadataBytes(): Promise<number> {
  try {
    const rows = await db.metadataCache
      .where("key")
      .startsWith(METADATA_KEY_PREFIX)
      .toArray();
    // Estimate: UTF-16 code units of the JSON-serialized entry (~2 bytes each
    // for ASCII) as a proxy for the stored record size — not an exact byte
    // count of the on-disk IndexedDB record.
    return rows.reduce((sum, row) => sum + JSON.stringify(row.entry).length, 0);
  } catch (e: unknown) {
    await captureError({
      level: "warn",
      source: "cache",
      message: `get-cache-size-metadata failed: ${errorMessage(e)}`,
    });
    return 0;
  }
}

async function estimateFilesBytes(): Promise<number> {
  try {
    const count = await db.files.count();
    return count * FILES_ROW_ESTIMATED_BYTES;
  } catch (e: unknown) {
    await captureError({
      level: "warn",
      source: "cache",
      message: `get-cache-size-files failed: ${errorMessage(e)}`,
    });
    return 0;
  }
}

interface RustCacheInfo {
  cover_cache_bytes: number;
  thumbnail_dir_bytes: number;
}

async function estimateCoversBytes(): Promise<number> {
  try {
    const info = await invoke<RustCacheInfo>(GET_CACHE_INFO_CMD);
    return info.cover_cache_bytes + info.thumbnail_dir_bytes;
  } catch (e: unknown) {
    await captureError({
      level: "warn",
      source: "cache",
      message: `get-cache-size-covers failed: ${errorMessage(e)}`,
    });
    return 0;
  }
}

function estimatePrefetchBytes(): number {
  try {
    const entries = getPrefetchedStreamCount();
    return entries * PREFETCH_ENTRY_ESTIMATED_BYTES;
  } catch (e: unknown) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "cache",
      message: `get-cache-size-prefetch failed: ${errorMessage(e)}`,
    });
    return 0;
  }
}

async function clearMetadataCache(): Promise<void> {
  let deleteError: unknown = null;
  try {
    await db.metadataCache
      .where("key")
      .startsWith(METADATA_KEY_PREFIX)
      .delete();
  } catch (e: unknown) {
    deleteError = e;
  }

  // LRU bookkeeping key — best-effort: a SecurityError here must not fail the
  // whole category (pre-existing behavior).
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(METADATA_LRU_KEY);
    } catch (removeErr: unknown) {
      await captureError({
        level: "warn",
        source: "cache",
        message: `clear-lru-key-failed: ${errorMessage(removeErr)}`,
      });
    }
  }

  // In-RAM metadata cache; surfaces as a category error but never shadows a
  // failed row delete (pre-existing priority).
  try {
    clearAllMetadataCache();
  } catch (metaErr: unknown) {
    await captureError({
      level: "error",
      source: "cache",
      message: `clear-memory-metadata-cache failed: ${errorMessage(metaErr)}`,
    });
    if (!deleteError) deleteError = metaErr;
  }

  if (deleteError) {
    // Error instances are rethrown as-is; a non-Error throw is wrapped so the
    // caller always receives a real Error (and stringification stays safe).
    throw deleteError instanceof Error
      ? deleteError
      : new Error(
          typeof deleteError === "string"
            ? deleteError
            : `unexpected error of type ${typeof deleteError}`,
        );
  }
}

async function clearCategory(
  category: CacheCategoryId,
  logPrefix: string,
  failures: Array<{ category: CacheCategoryId; error: unknown }>,
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (e: unknown) {
    failures.push({ category, error: e });
    await captureError({
      level: "error",
      source: "cache",
      message: `${logPrefix} failed: ${errorMessage(e)}`,
    });
  }
}

export async function clearAppCache(
  selected: CacheCategoryId[] = ALL_CACHE_CATEGORIES,
): Promise<void> {
  const failures: Array<{ category: CacheCategoryId; error: unknown }> = [];

  if (selected.includes("metadata")) {
    await clearCategory(
      "metadata",
      "clear-metadata-cache",
      failures,
      clearMetadataCache,
    );
  }
  if (selected.includes("files")) {
    await clearCategory("files", "clear-files-cache", failures, async () => {
      await db.files.clear();
    });
  }
  if (selected.includes("covers")) {
    await clearCategory("covers", "clear_local_cache", failures, async () => {
      await invoke(CLEAR_LOCAL_CACHE_CMD);
      await invoke(CLEAR_THUMBNAIL_DIR_CMD);
    });
  }
  if (selected.includes("prefetch")) {
    await clearCategory("prefetch", "clear-prefetch-cache", failures, () => {
      clearPrefetchedStreams();
    });
  }

  // Aggregate failure: SettingsTab surfaces the message in its error toast,
  // so the message must name every category that failed, not just one.
  if (failures.length > 0) {
    const detail = failures
      .map((f) => `${f.category} (${errorMessage(f.error)})`)
      .join(", ");
    throw new Error(`Failed to clear cache for: ${detail}`);
  }
}
