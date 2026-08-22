import { db } from "../../db/db";
import { captureError } from "../errorLog";
import {
  CACHE_VERSION,
  FRESH_WRITE_WINDOW_MS,
  FULL_PICTURE_MEM_BYTES_MAX,
  FULL_PICTURE_MEM_ENTRIES_MAX,
  FULL_PERSIST_MAX_BYTES,
  JPEG_MIME,
  MAX_LRU_CACHE,
  MAX_MEM_CACHE,
  METADATA_KEY_PREFIX,
  METADATA_LRU_KEY,
  META_MODULE,
  V_PLACEHOLDER,
} from "./constants";
import { clearNetworkCooldown } from "./fetchPipeline";
import type { CacheEntry, CachedMetadata } from "./types";

export function classifyMetaError(err: unknown): {
  name: string;
  message: string;
} {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "UnknownError", message: String(err) };
}

let lruKeys: string[] = [];
try {
  // Non-browser runtimes (node tests/SSR) have no localStorage — skipping the
  // read keeps a ReferenceError from turning into a spurious lru-load-failed
  // warn on every module import. In a browser the branch is identical to the
  // unguarded read: getItem/parse failures still fall through to the catch.
  const stored =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(METADATA_LRU_KEY)
      : null;
  if (stored) {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      // Keep only string keys; non-string junk in a stored array is dropped
      // (lruKeys is a string[] — assigning raw would be unsound).
      lruKeys = parsed.filter(
        (k: unknown): k is string => typeof k === "string",
      );
    }
  }
} catch (e: unknown) {
  // fire-and-forget: logging must not throw in this module-init sync path
  // (captureError never rejects — it swallows failures internally).
  void captureError({
    level: "warn",
    source: META_MODULE,
    message: `lru-load-failed: ${classifyMetaError(e).message}`,
  });
}

// Shared LRU helpers: `touchLruKeys` moves `id` to the back (most-recently
// written goes last), `evictLruKeys` shifts the oldest entry while
// `shouldEvict` holds. lruKeys (IDB) and mem metadataCache use these helpers;
// fullPictureCache mirrors the same write-LRU ordering natively via Map
// delete+set. The per-cache differences live in the onEvict callback.
function touchLruKeys(keys: string[], id: string): void {
  keys.splice(0, keys.length, ...keys.filter((k) => k !== id), id);
}

function evictLruKeys(
  keys: string[],
  shouldEvict: () => boolean,
  onEvict: (id: string) => void,
): void {
  while (shouldEvict()) {
    const oldest = keys.shift();
    // shouldEvict may stay true with an empty array (e.g. a byte budget the
    // remaining entries can never satisfy) — break instead of spinning.
    if (oldest === undefined) break;
    onEvict(oldest);
  }
}

function updateLRU(key: string) {
  touchLruKeys(lruKeys, key);

  evictLruKeys(
    lruKeys,
    () => lruKeys.length > MAX_LRU_CACHE,
    (oldest) => {
      db.metadataCache.delete(oldest).catch((e: unknown) =>
        captureError({
          level: "error",
          source: META_MODULE,
          message: `lru-delete-failed: ${classifyMetaError(e).message}`,
        }),
      );
    },
  );

  try {
    localStorage.setItem(METADATA_LRU_KEY, JSON.stringify(lruKeys));
  } catch (e: unknown) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: META_MODULE,
      message: `lru-save-failed: ${classifyMetaError(e).message}`,
    });
  }
}

export async function getCacheEntry(
  key: string,
): Promise<CacheEntry | undefined> {
  const row = await db.metadataCache.get(key);
  const entry = row?.entry;
  if (isCacheEntry(entry) && entry.version === CACHE_VERSION) {
    return entry;
  }
  return undefined;
}

// Shape guard for a cached row: a row whose version happens to match but whose
// payload is garbage (e.g. data: {} or a string from a partial write) is a
// MISS, not a hit — parity with parseDiskMetadata, which validates the full
// entry before trusting it.
function isCacheEntry(u: unknown): u is CacheEntry {
  if (typeof u !== "object" || u === null) return false;
  const entry = u as Record<string, unknown>;
  const data = entry.data;
  return (
    typeof entry.version === "number" &&
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>).v === "number" &&
    typeof entry.ts === "number"
  );
}

export async function putCacheEntry(
  key: string,
  entry: CacheEntry,
): Promise<void> {
  await db.metadataCache.put({ key, entry });
}

export const metadataCache = new Map<string, CachedMetadata>();
const memCacheKeys: string[] = [];

// Map.get carries the true nullability in its type (CachedMetadata | undefined)
// so guards below are checked by the compiler instead of by comment.
export function getMemCacheEntry(fileId: string): CachedMetadata | undefined {
  return metadataCache.get(fileId);
}

export function setMetadataCache(fileId: string, entry: CachedMetadata) {
  touchLruKeys(memCacheKeys, fileId);
  metadataCache.set(fileId, entry);
  evictLruKeys(
    memCacheKeys,
    () => memCacheKeys.length > MAX_MEM_CACHE,
    (oldest) => {
      // Map.delete physically removes the key, preserving the memory bound.
      metadataCache.delete(oldest);
    },
  );
}

export function cacheTrackMetadata(
  fileId: string,
  entry: CachedMetadata,
): CachedMetadata {
  // Memory cache NEVER holds full bytes (the dedicated LRU is their owner).
  const stored: CachedMetadata = { ...entry, pictureDataFull: null };
  setMetadataCache(fileId, stored);
  // IDB persists the full variant ONLY for small JPEGs: after a restart the
  // persisted bytes seed the LRU so cards render sharp immediately. PNG/WebP
  // originals and oversized JPEGs stay memory-only so IDB cannot balloon.
  const idbEntry: CachedMetadata = canPersistFullPicture(entry)
    ? { ...stored, pictureDataFull: entry.pictureDataFull }
    : stored;
  setCache(`${METADATA_KEY_PREFIX}${fileId}`, idbEntry).catch((e: unknown) =>
    captureError({
      level: "warn",
      source: META_MODULE,
      message: `cache-set-failed: ${classifyMetaError(e).message}`,
    }),
  );
  return entry;
}

function canPersistFullPicture(entry: CachedMetadata): boolean {
  return (
    entry.pictureFormat === JPEG_MIME &&
    entry.pictureDataFull !== null &&
    entry.pictureDataFull.byteLength <= FULL_PERSIST_MAX_BYTES
  );
}

const fullPictureCache = new Map<string, Uint8Array>();
let fullPictureBytes = 0;

export function setFullPictureCache(fileId: string, data: Uint8Array): void {
  if (fullPictureCache.has(fileId)) {
    fullPictureBytes -= fullPictureCache.get(fileId)?.byteLength ?? 0;
  }
  // delete+set is the Map-native write-touch: the key re-inserts at the tail,
  // making the oldest entry the one at the head (iteration order).
  fullPictureCache.delete(fileId);
  fullPictureCache.set(fileId, data);
  fullPictureBytes += data.byteLength;
  evictFullPictures();
}

function evictFullPictures(): void {
  while (
    fullPictureCache.size > FULL_PICTURE_MEM_ENTRIES_MAX ||
    fullPictureBytes > FULL_PICTURE_MEM_BYTES_MAX
  ) {
    const oldest = fullPictureCache.keys().next().value;
    // shouldEvict may stay true with an empty Map (e.g. a byte budget the
    // remaining entries can never satisfy) — break instead of spinning.
    if (oldest === undefined) break;
    const removed = fullPictureCache.get(oldest);
    if (removed) fullPictureBytes -= removed.byteLength;
    fullPictureCache.delete(oldest);
  }
}

/**
 * Returns the cached full-size cover for a fileId, or null. S4 (full cover
 * viewer) reads through this; cache-hit paths merge the value onto the entry.
 */
export function getFullPictureData(fileId: string): Uint8Array | null {
  return fullPictureCache.get(fileId) ?? null;
}

/**
 * Merges the memory LRU's full picture onto a cached entry WITHOUT writing it
 * into the mem/IDB cache (the LRU is the single owner of full bytes, so
 * eviction can free them). Returns the same reference when there is no full
 * picture — callers relying on cache-hit reference identity keep it.
 */
export function mergeFullPicture(
  fileId: string,
  entry: CachedMetadata,
): CachedMetadata {
  const full = fullPictureCache.get(fileId);
  if (!full || entry.pictureDataFull === full) return entry;
  return { ...entry, pictureDataFull: full };
}

let cacheGeneration = 0;

// Mem-layer teardown shared by clearAllMetadataCache (memory-only reset) and
// wipePersistedMetadataCache (account-boundary wipe). Bumping cacheGeneration
// also drops any in-flight setCache put/updateLRU, so no stale row can be
// resurrected into IDB/localStorage after a clear/wipe has started.
function clearMemMetadataCaches(): void {
  cacheGeneration++;
  metadataCache.clear();
  memCacheKeys.length = 0;
  lruKeys = [];
  fullPictureCache.clear();
  fullPictureBytes = 0;
  // A cleared cache is a CLEAN state: the per-file network cooldowns (set by
  // fetchPipeline on a real network failure) must go too, or files that failed
  // once stay placeholder-blocked up to METADATA_NETWORK_COOLDOWN_MS despite
  // the user's explicit full reset.
  clearNetworkCooldown();
}

export function clearAllMetadataCache(): void {
  clearMemMetadataCaches();
}

/**
 * Account-boundary wipe (logout): metadataCache IDB rows carry NO userEmail
 * (every other per-user table moved to [userEmail+id] in schema v7), so rows
 * left behind by user A would be served to user B. Metadata is re-fetchable
 * cache data, so instead of a schema migration this wipes EVERYTHING: the mem
 * layers (via clearAllMetadataCache semantics) + the persisted localStorage
 * LRU list + all metadataCache rows in IndexedDB (bulk delete). Best-effort:
 * individual failures are logged and never reject — logout must proceed.
 */
export async function wipePersistedMetadataCache(): Promise<void> {
  clearMemMetadataCaches();

  // Drop the persisted LRU bookkeeping BEFORE deleting the rows so an
  // interrupted wipe never leaves a key list pointing at deleted rows.
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(METADATA_LRU_KEY);
    }
  } catch (e: unknown) {
    void captureError({
      level: "warn",
      source: META_MODULE,
      message: `lru-wipe-failed: ${classifyMetaError(e).message}`,
    });
  }

  try {
    const keys = await db.metadataCache.toCollection().primaryKeys();
    await db.metadataCache.bulkDelete(keys);
  } catch (e: unknown) {
    // Logged, not rethrown: fire-and-forget callers treat resolution as "wipe
    // finished", and a failed bulk delete is recoverable (rows are cache).
    void captureError({
      level: "error",
      source: META_MODULE,
      message: `metadata-idb-wipe-failed: ${classifyMetaError(e).message}`,
    });
  }
}

// Rank used by setCache to order writes. Raw data.v must NOT be compared
// directly: placeholders (v >= V_PLACEHOLDER) sort numerically above real
// parses (v = REAL_METADATA_VERSION), so a placeholder could clobber a real
// row and a stored v9 row could block real parses forever. Real always wins
// over placeholder; among same-rank entries the fresh-write window decides.
const PLACEHOLDER_RANK = -1;

function scoreOf(entry: CachedMetadata): number {
  // Parity with searchEngine.isRealCacheEntry: any v < V_PLACEHOLDER is a
  // real parse, everything else is a placeholder.
  return entry.v < V_PLACEHOLDER ? entry.v : PLACEHOLDER_RANK;
}

export async function setCache(
  key: string,
  newEntry: CachedMetadata,
): Promise<void> {
  const genAtStart = cacheGeneration;
  const existing = await getCacheEntry(key);
  if (genAtStart !== cacheGeneration) return;

  const newScore = scoreOf(newEntry);
  const oldScore = existing ? scoreOf(existing.data) : PLACEHOLDER_RANK;

  if (existing && oldScore > newScore) return;
  if (
    existing &&
    oldScore === newScore &&
    existing.ts > Date.now() - FRESH_WRITE_WINDOW_MS
  )
    return;

  await putCacheEntry(key, {
    version: CACHE_VERSION,
    data: newEntry,
    ts: Date.now(),
  });
  // Same TOCTOU as the get-side guard: clearAllMetadataCache() may bump the
  // generation while this put is in flight. Touching the LRU now would
  // resurrect the key into localStorage/bookkeeping AFTER the user's clear,
  // so re-check before updateLRU (the stale row itself, if it landed past the
  // clear's IDB delete, stays orphaned bookkeeping-wise until the next clear).
  if (genAtStart !== cacheGeneration) return;
  updateLRU(key);
}
