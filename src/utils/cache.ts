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
export const STATUS_FALLBACK_CMD = "get_mpv_fallback_status";
export const REMOVE_FALLBACK_CMD = "remove_mpv_fallback";

export type CacheCategoryId = "metadata" | "files" | "covers" | "prefetch";

/**
 * The mpv.exe fallback engine is NOT a cache category: it is an installed
 * optional binary with its own removal command, and it is absent on most
 * machines. It therefore gets its own id instead of joining
 * {@link CacheCategoryId} (which would break the fixed four-row size/shape
 * contract that `getCacheSizes` and the modal rely on), and is handled
 * explicitly by the two helpers below.
 */
export const FALLBACK_ENGINE_ID = "fallback_engine";

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

/** Every invoke rejection from the fallback commands is "<code>: <text>". */
const ERROR_CODE_SEPARATOR = ": ";

/**
 * Installed size of the optional mpv.exe fallback engine, or `null` when it is
 * not installed.
 *
 * `null` is the UI's "hide the row" signal, so it must mean "nothing to
 * remove" — an `invalid` install has bytes on disk but is still deletable, so
 * it reports its directory size too. Any read failure degrades to `null`
 * (the row stays hidden) rather than blocking the dialog: this is an additive
 * row, never a prerequisite for clearing the four cache categories.
 */
export async function getFallbackEngineSize(): Promise<number | null> {
  try {
    const status = await invoke<unknown>(STATUS_FALLBACK_CMD);
    if (typeof status !== "object" || status === null) return null;
    const record = status as Record<string, unknown>;
    const stage = record["stage"];
    if (stage === "notInstalled") return null;
    // `installed` always carries a size; `invalid` may not, and a missing size
    // on a present install still deserves a row (0 B is honest for "unknown").
    const size = record["size"];
    return typeof size === "number" ? size : 0;
  } catch (e: unknown) {
    await captureError({
      level: "warn",
      source: "cache",
      message: `get-fallback-engine-size failed: ${errorMessage(e)}`,
    });
    return null;
  }
}

/**
 * Removes the installed fallback engine.
 *
 * Rejections are re-thrown as a real `Error` carrying the backend prose (the
 * stable `code` slug is logged, not rendered: callers surface one aggregate
 * message). This is deliberately separate from `clearAppCache`: it deletes an
 * installed binary, not cached data.
 */
export async function removeFallbackEngine(): Promise<void> {
  try {
    await invoke(REMOVE_FALLBACK_CMD);
  } catch (e: unknown) {
    const raw = errorMessage(e);
    const separatorIndex = raw.indexOf(ERROR_CODE_SEPARATOR);
    const code = separatorIndex > 0 ? raw.slice(0, separatorIndex) : "unknown";
    const detail = separatorIndex > 0 ? raw.slice(separatorIndex + 2) : raw;
    await captureError({
      level: "error",
      source: "cache",
      message: `remove-fallback-engine failed (${code}): ${detail}`,
    });
    throw new Error(detail);
  }
}

export async function getCacheSizes(): Promise<CacheCategoryInfo[]> {
  // The three async estimates are independent (2 IndexedDB reads + the Rust
  // recursive dir walk over covers, by far the slowest) — run them together
  // instead of stacking their latencies; the destructure keeps the order.
  const [metadataBytes, filesBytes, coversBytes] = await Promise.all([
    estimateMetadataBytes(),
    estimateFilesBytes(),
    estimateCoversBytes(),
  ]);
  const prefetchBytes = estimatePrefetchBytes();
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
      // Two independent commands: clear_local_cache only invalidates the
      // in-RAM moka cache (cover.rs), clear_thumbnail_dir is the disk wipe.
      // Run both — a failure of the first must not skip the second, or every
      // retry fails on step one and the disk is never reclaimed.
      const results = await Promise.allSettled([
        invoke(CLEAR_LOCAL_CACHE_CMD),
        invoke(CLEAR_THUMBNAIL_DIR_CMD),
      ]);
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (rejected.length > 0) {
        // Single failure keeps its original message; both failures aggregate.
        throw new Error(rejected.map((r) => errorMessage(r.reason)).join("; "));
      }
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
