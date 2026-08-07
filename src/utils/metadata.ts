import { parseFromTokenizer } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import { db } from "../db/db";
import { captureError } from "./errorLog";
import {
  BudgetExceededError,
  BUDGET_CAP,
  DriveRangeTokenizer,
  HEAD_BYTES,
  TAIL_BYTES,
} from "./driveRangeTokenizer";
import {
  compressCoverImage,
  isImageTruncated,
  COVER_MAX_BYTES,
  FULL_MAX_SIZE,
  FULL_QUALITY,
  THUMB_MAX_SIZE,
  THUMB_QUALITY,
} from "./coverCompress";
import {
  detectFormat,
  scanTailForMoov,
  walkMp4TopBoxes,
  type AudioFormat,
} from "./audioFormat";
import { postCoverToCache } from "./coverStore";

const META_MODULE = "metadata";
export const METADATA_LRU_KEY = "__drplay_metadata_lru";
export const METADATA_KEY_PREFIX = "metadata_";
const UNKNOWN_ARTIST = "Unknown Artist";
const FALLBACK_AUDIO_FILENAME = "audio.mp3";
const METADATA_UPDATED_EVENT = "metadata-updated";
export const V_PLACEHOLDER = 9;
// Real parsed entries carry v=8: searchEngine.isRealCacheEntry accepts any
// data.v < V_PLACEHOLDER, so real metadata becomes searchable while v:9
// placeholders stay invisible. Keep V_PLACEHOLDER untouched (tests depend on
// the exact 9).
const REAL_METADATA_VERSION = 8;
const FRESH_WRITE_WINDOW_MS = 5_000;
// ID3v2 tag budget (Task B): MP3s carry their cover inside the ID3v2 tag and
// music-metadata reads the WHOLE tag body up-front (one readToken) — a tag
// larger than the default 20MB fetch budget nuked the entire entry (v:9
// placeholder). These constants bound the raised per-file budget.
export const TAG_BUDGET_MAX = 32 * 1024 * 1024; // hard cap for the raised budget
export const COVER_SLACK_BYTES = 1 * 1024 * 1024; // 64KB chunk alignment + frame overhead
const ID3V2_HEADER_LEN = 10;

/**
 * ID3v2 syncsafe tag-body size from the 10-byte header, or 0 when the buffer
 * is too short / not an ID3v2 header. Syncsafe = 4 bytes with MSB 0 each
 * (28-bit value), bytes 6-9 (id3.org/id3v2.3.0#ID3v2_header).
 */
function readId3v2TagSize(head: Uint8Array): number {
  if (head.length < ID3V2_HEADER_LEN) return 0;
  if (!(head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)) return 0;
  const b6 = head[6] ?? 0;
  const b7 = head[7] ?? 0;
  const b8 = head[8] ?? 0;
  const b9 = head[9] ?? 0;
  return (
    ((b6 & 0x7f) << 21) | ((b7 & 0x7f) << 14) | ((b8 & 0x7f) << 7) | (b9 & 0x7f)
  );
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function classifyMetaError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "UnknownError", message: String(err) };
}

const MAX_LRU_CACHE = 100;
let lruKeys: string[] = [];
try {
  const stored = localStorage.getItem(METADATA_LRU_KEY);
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

function updateLRU(key: string) {
  lruKeys = lruKeys.filter((k) => k !== key);
  lruKeys.push(key);

  while (lruKeys.length > MAX_LRU_CACHE) {
    const oldest = lruKeys.shift();
    if (oldest) {
      db.metadataCache.delete(oldest).catch((e: unknown) =>
        captureError({
          level: "error",
          source: META_MODULE,
          message: `lru-delete-failed: ${classifyMetaError(e).message}`,
        }),
      );
    }
  }

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

const CACHE_VERSION = 2;
const inflightMetadata = new Map<string, Promise<CachedMetadata>>();
const INFLIGHT_TIMEOUT = 30_000;

export interface CachedMetadata {
  title: string;
  artist: string;
  album?: string;
  duration: number;
  durationEstimated: boolean;
  pictureData: Uint8Array | null;
  pictureDataFull: Uint8Array | null;
  pictureFormat?: string;
  bitrate?: number;
  size?: number;
  v: number;
}

interface CacheEntry {
  version: number;
  data: CachedMetadata;
  ts: number;
}

async function getCacheEntry(key: string): Promise<CacheEntry | undefined> {
  const row = await db.metadataCache.get(key);
  const entry = row?.entry;
  if (
    entry &&
    typeof entry === "object" &&
    (entry as { version?: unknown }).version === CACHE_VERSION
  ) {
    return entry as CacheEntry;
  }
  return undefined;
}

async function putCacheEntry(key: string, entry: CacheEntry): Promise<void> {
  await db.metadataCache.put({ key, entry });
}

export const metadataCache: Record<string, CachedMetadata> = {};
const MAX_MEM_CACHE = 1000; // 1000 entries cap; entries may carry pictureData (thumb) so real usage can reach tens of MB - bounded by count, not bytes.
const memCacheKeys: string[] = [];

// The Record type claims every key exists, but a fileId with no cached entry
// is undefined at runtime — this helper surfaces the true shape so guards
// below are checked (and lint-visible) instead of lying about nullability.
function getMemCacheEntry(fileId: string): CachedMetadata | undefined {
  return metadataCache[fileId];
}

function setMetadataCache(fileId: string, entry: CachedMetadata) {
  const existing = getMemCacheEntry(fileId);
  if (existing) {
    const idx = memCacheKeys.indexOf(fileId);
    if (idx !== -1) memCacheKeys.splice(idx, 1);
  }
  memCacheKeys.push(fileId);
  metadataCache[fileId] = entry;
  while (memCacheKeys.length > MAX_MEM_CACHE) {
    const oldest = memCacheKeys.shift();
    if (oldest) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional: the eviction cap must PHYSICALLY remove the key (assigning undefined would leave it enumerable and defeat the memory bound).
      delete metadataCache[oldest];
    }
  }
}

export function cacheTrackMetadata(
  fileId: string,
  entry: CachedMetadata,
): CachedMetadata {
  const stored: CachedMetadata = { ...entry, pictureDataFull: null };
  setMetadataCache(fileId, stored);
  setCache(`${METADATA_KEY_PREFIX}${fileId}`, stored).catch((e: unknown) =>
    captureError({
      level: "warn",
      source: META_MODULE,
      message: `cache-set-failed: ${classifyMetaError(e).message}`,
    }),
  );
  return entry;
}

// ---- Full-picture (≤1000px JPEG) memory LRU. Thumbnails persist in IDB via
// cacheTrackMetadata; full pictures are memory-only (S3 will move them to a
// disk cache) and are evicted oldest-first until BOTH caps hold.
const FULL_PICTURE_MEM_ENTRIES_MAX = 64;
const FULL_PICTURE_MEM_BYTES_MAX = 16 * 1024 * 1024;
const fullPictureCache = new Map<string, Uint8Array>();
let fullPictureOrder: string[] = [];
let fullPictureBytes = 0;

function setFullPictureCache(fileId: string, data: Uint8Array): void {
  if (fullPictureCache.has(fileId)) {
    fullPictureBytes -= fullPictureCache.get(fileId)?.byteLength ?? 0;
  }
  fullPictureCache.set(fileId, data);
  fullPictureBytes += data.byteLength;
  fullPictureOrder = fullPictureOrder.filter((id) => id !== fileId);
  fullPictureOrder.push(fileId);
  evictFullPictures();
}

function evictFullPictures(): void {
  while (
    fullPictureOrder.length > FULL_PICTURE_MEM_ENTRIES_MAX ||
    fullPictureBytes > FULL_PICTURE_MEM_BYTES_MAX
  ) {
    const oldest = fullPictureOrder.shift();
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
function mergeFullPicture(
  fileId: string,
  entry: CachedMetadata,
): CachedMetadata {
  const full = fullPictureCache.get(fileId);
  if (!full || entry.pictureDataFull === full) return entry;
  return { ...entry, pictureDataFull: full };
}

let cacheGeneration = 0;

export function clearAllMetadataCache(): void {
  cacheGeneration++;
  for (const k of Object.keys(metadataCache)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional: must fully drop every key so Object.keys(metadataCache) is 0 after clear (test asserts this; assigning undefined would keep the keys).
    delete metadataCache[k];
  }
  memCacheKeys.length = 0;
  lruKeys = [];
  fullPictureCache.clear();
  fullPictureOrder = [];
  fullPictureBytes = 0;
}

async function setCache(key: string, newEntry: CachedMetadata): Promise<void> {
  const genAtStart = cacheGeneration;
  const existing = await getCacheEntry(key);
  if (genAtStart !== cacheGeneration) return;

  const newScore = newEntry.v;
  const oldScore = existing?.data.v ?? 0;

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
  updateLRU(key);
}

async function getTrackMetadataImpl(
  fileId: string,
  _token?: string,
  _size?: number,
  name?: string,
  signal?: AbortSignal,
  forceNetwork: boolean = false,
): Promise<CachedMetadata> {
  // fileId with no cached entry is undefined at runtime — guard it.
  const memEntry = getMemCacheEntry(fileId);
  if (!forceNetwork && memEntry) {
    return mergeFullPicture(fileId, memEntry);
  }

  const safeName = name ?? FALLBACK_AUDIO_FILENAME;

  // 1. IDB Check
  if (!forceNetwork) {
    try {
      const cached = await getCacheEntry(`${METADATA_KEY_PREFIX}${fileId}`);
      if (cached) {
        setMetadataCache(fileId, cached.data);
        return mergeFullPicture(fileId, cached.data);
      }
    } catch (e: unknown) {
      await captureError({
        level: "warn",
        source: META_MODULE,
        message: `idb-read-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
      });
    }
  }

  const size = _size ?? 0;
  if (size <= 0) {
    // Size unknown: a range fetch is impossible — placeholder without touching
    // the network (Drive does not report a size for this file).
    const placeholder = makePlaceholder(safeName);
    setMetadataCache(fileId, placeholder);
    return placeholder;
  }

  let format: AudioFormat = "unknown";
  try {
    let tokenizer = new DriveRangeTokenizer(
      fileId,
      size,
      signal ? { abortSignal: signal } : {},
    );

    // 2. Head fetch (128KB, chunk-aligned) — format detection + m4a box walk
    const head = await tokenizer.readRange(0, Math.min(HEAD_BYTES, size));
    format = detectFormat(head, name);

    if (format === "mp3") {
      // ID3v2 tags are read WHOLE by music-metadata (one readToken of the tag
      // body) — an unusually large tag (e.g. a 25MB cover) blows the default
      // 20MB fetch budget and nukes the whole entry. Raise the budget for the
      // tag region (capped at TAG_BUDGET_MAX); rare files only. The new
      // tokenizer re-fetches the head region — one extra request, accepted.
      const tagSize = readId3v2TagSize(head);
      const tagBudgetNeeded = tagSize + ID3V2_HEADER_LEN + COVER_SLACK_BYTES;
      if (tagSize > 0 && tagBudgetNeeded > BUDGET_CAP) {
        tokenizer = new DriveRangeTokenizer(fileId, size, {
          budgetBytes: Math.min(tagBudgetNeeded, TAG_BUDGET_MAX),
          ...(signal ? { abortSignal: signal } : {}),
        });
      }
    }

    if (format === "aac") {
      // ADTS has no embedded tags and music-metadata would scan the whole
      // stream for duration — skip parsing entirely, no further fetch.
      const placeholder = makePlaceholder(safeName);
      setMetadataCache(fileId, placeholder);
      return placeholder;
    }

    // 3. Parse tags/duration from the file via range fetches (moov at the end
    //    of an m4a is reached by ignore()-advancing past mdat — no download).
    //    fileInfo.size rides on the tokenizer; options carry parser behavior.
    //    skipCovers: false lets the parser read embedded cover art through the
    //    tokenizer; if that read blows the fetch budget the text is salvaged
    //    by re-parsing with covers skipped (works for formats whose cover is
    //    read after the tags, e.g. FLAC; ID3v2 reads the whole tag up-front so
    //    a cover that large falls back to the placeholder below).
    let metadata: IAudioMetadata;
    try {
      metadata = await parseFromTokenizer(tokenizer, {
        skipCovers: false,
        duration: true,
      });
    } catch (e: unknown) {
      if (e instanceof BudgetExceededError) {
        await captureError({
          level: "warn",
          source: META_MODULE,
          message: `cover-budget-exceeded (fileId=${fileId}, size=${String(size)}): ${classifyMetaError(e).message}`,
          kind: "BudgetExceededError",
        });
        // Re-parse with covers skipped on a FRESH tokenizer: the old one has
        // exhausted its fetch budget (even its tail-scan would throw again).
        // A fresh budget plus ignore()-advancing past the cover reads only the
        // tag region — no full-file download.
        const retryTokenizer = new DriveRangeTokenizer(
          fileId,
          size,
          signal ? { abortSignal: signal } : {},
        );
        metadata = await parseFromTokenizer(retryTokenizer, {
          skipCovers: true,
          duration: true,
        });
      } else {
        throw e;
      }
    }

    const parsedDuration = metadata.format.duration;
    const hasRealDuration =
      typeof parsedDuration === "number" &&
      Number.isFinite(parsedDuration) &&
      parsedDuration > 0;

    const entry: CachedMetadata = {
      title: metadata.common.title ?? stripExtension(safeName),
      artist: metadata.common.artist ?? UNKNOWN_ARTIST,
      album: metadata.common.album ?? "",
      duration: hasRealDuration ? parsedDuration : 0,
      durationEstimated: !hasRealDuration,
      pictureData: null,
      pictureDataFull: null,
      v: REAL_METADATA_VERSION,
      size,
    };
    if (
      typeof metadata.format.bitrate === "number" &&
      Number.isFinite(metadata.format.bitrate)
    ) {
      entry.bitrate = metadata.format.bitrate;
    }

    // 3b. Cover: compress the embedded picture into a persisted thumb (≤256px)
    //    and a memory-only full variant (≤1000px, full-picture LRU). A failing
    //    picture NEVER drops the text entry — every branch below warns and
    //    skips, leaving entry v:8 fully populated.
    const pictures = metadata.common.picture;
    if (pictures && pictures.length > 0) {
      const pic = pictures[0];
      if (pic) {
        if (pic.data.byteLength > COVER_MAX_BYTES) {
          await captureError({
            level: "warn",
            source: META_MODULE,
            message: `cover-skip-too-large (fileId=${fileId}, bytes=${String(pic.data.byteLength)})`,
            kind: "CoverTooLarge",
          });
        } else if (isImageTruncated(pic.data)) {
          await captureError({
            level: "warn",
            source: META_MODULE,
            message: `cover-skip-truncated (fileId=${fileId}, format=${pic.format})`,
            kind: "CoverTruncated",
          });
        } else {
          try {
            const thumb = await compressCoverImage(
              pic.data,
              pic.format,
              THUMB_MAX_SIZE,
              THUMB_QUALITY,
            );
            entry.pictureData = thumb.data;
            entry.pictureFormat = thumb.format;
            // S4: push the compressed thumb to the Rust disk cache. Fire-and-
            // forget on purpose — postCoverToCache never rejects, so the render
            // hot path is never blocked by a disk hiccup (non-fatal by design).
            void postCoverToCache(fileId, true, thumb.data);
          } catch (e: unknown) {
            await captureError({
              level: "warn",
              source: META_MODULE,
              message: `cover-compress-failed (fileId=${fileId}, variant=thumb): ${classifyMetaError(e).message}`,
              kind: e instanceof Error ? e.name : "UnknownError",
            });
          }
          try {
            const full = await compressCoverImage(
              pic.data,
              pic.format,
              FULL_MAX_SIZE,
              FULL_QUALITY,
            );
            entry.pictureDataFull = full.data;
            setFullPictureCache(fileId, full.data);
            // S4: push the compressed full variant to the Rust disk cache too
            // (fire-and-forget, non-fatal — see the thumb POST above).
            void postCoverToCache(fileId, false, full.data);
          } catch (e: unknown) {
            await captureError({
              level: "warn",
              source: META_MODULE,
              message: `cover-compress-failed (fileId=${fileId}, variant=full): ${classifyMetaError(e).message}`,
              kind: e instanceof Error ? e.name : "UnknownError",
            });
          }
        }
      }
    }

    // 4. m4a faststart check: moov must precede mdat or the file cannot be
    //    streamed progressively (non-faststart). A moov found in the tail
    //    confirms the layout; its absence means no moov anywhere — both are
    //    marked streamUnplayable.
    let streamUnplayable = false;
    if (format === "m4a") {
      const walk = walkMp4TopBoxes(head, size);
      if (walk.mdatBeforeMoov && !walk.moovBeforeMdat) {
        streamUnplayable = true;
        try {
          const tailStart = Math.max(0, size - TAIL_BYTES);
          const tail = await tokenizer.readRange(tailStart, size);
          if (scanTailForMoov(tail, size) === null) {
            await captureError({
              level: "warn",
              source: META_MODULE,
              message: `m4a-tail-scan: no moov box found at the end of file (fileId=${fileId}, size=${String(size)})`,
            });
          }
        } catch (e: unknown) {
          await captureError({
            level: "warn",
            source: META_MODULE,
            message: `m4a-tail-scan-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
          });
        }
      }
    }

    // 5. Non-faststart m4a: persist the flag on the files row so the player
    //    can avoid streaming it (schema field is pre-existing, untouched).
    if (streamUnplayable) {
      try {
        await db.files.update(fileId, {
          metadata: { format, streamUnplayable: true },
        });
      } catch (e: unknown) {
        await captureError({
          level: "warn",
          source: META_MODULE,
          message: `files-metadata-write-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
        });
      }
    }

    // 6. IDB + memory cache (setCache keeps the generation guard + score rules)
    cacheTrackMetadata(fileId, entry);
    return entry;
  } catch (e: unknown) {
    await captureError({
      level: "warn",
      source: META_MODULE,
      message: `metadata-fetch-failed (fileId=${fileId}, size=${String(size)}, format=${format}): ${classifyMetaError(e).message}`,
      kind: e instanceof Error ? e.name : "UnknownError",
    });
    const placeholder = makePlaceholder(safeName);
    setMetadataCache(fileId, placeholder);
    return placeholder;
  }
}

function makePlaceholder(safeName: string): CachedMetadata {
  return {
    title: stripExtension(safeName),
    artist: UNKNOWN_ARTIST,
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: V_PLACEHOLDER,
  };
}

export async function getTrackMetadata(
  fileId: string,
  token?: string,
  size?: number,
  name?: string,
  signal?: AbortSignal,
  forceNetwork: boolean = false,
): Promise<CachedMetadata> {
  if (!forceNetwork) {
    // fileId with no cached entry is undefined at runtime — guard it.
    const cached = getMemCacheEntry(fileId);
    if (cached) return mergeFullPicture(fileId, cached);
  }

  if (!forceNetwork) {
    const existing = inflightMetadata.get(fileId);
    if (existing) return existing;
  }

  const promise = getTrackMetadataImpl(
    fileId,
    token,
    size,
    name,
    signal,
    forceNetwork,
  );

  inflightMetadata.set(fileId, promise);

  const cleanup = () => {
    if (inflightMetadata.get(fileId) === promise) {
      inflightMetadata.delete(fileId);
    }
  };
  // Once the timeout fires or the promise settles, cleanup removes the
  // inflight entry — the guard makes the delete idempotent, so an early
  // settle followed by the later timer firing is a harmless no-op.
  setTimeout(cleanup, INFLIGHT_TIMEOUT);

  promise.then(
    (result) => {
      cleanup();
      return result;
    },
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // fire-and-forget: logging must not throw in this sync callback
      // (captureError never rejects — it swallows failures internally).
      void captureError({
        level: "error",
        source: META_MODULE,
        message: `get-track-metadata-failed (fileId=${fileId}): ${msg}`,
      });
      cleanup();
    },
  );

  return promise;
}

export async function updateTrackDuration(
  fileId: string,
  accurateDuration: number,
): Promise<void> {
  // fileId with no cached entry is undefined at runtime — guard it.
  const memEntry = getMemCacheEntry(fileId);
  if (memEntry) {
    memEntry.duration = accurateDuration;
    memEntry.durationEstimated = false;
  }
  // IDB persistence is best-effort: the memory cache above is the source of
  // truth for the current session, so a store failure must not reject the
  // caller — log and still notify listeners (they re-read from memory).
  try {
    const key = `${METADATA_KEY_PREFIX}${fileId}`;
    const entry = await getCacheEntry(key);
    if (entry?.data) {
      entry.data.duration = accurateDuration;
      entry.data.durationEstimated = false;
      entry.ts = Date.now();
      await putCacheEntry(key, entry);
    }
  } catch (e: unknown) {
    await captureError({
      level: "warn",
      source: META_MODULE,
      message: `duration-persist-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
    });
  }
  window.dispatchEvent(
    new CustomEvent(METADATA_UPDATED_EVENT, { detail: { fileId } }),
  );
}
