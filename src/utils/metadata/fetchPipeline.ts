import { parseFromTokenizer } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../../db/db";
import { captureError } from "../errorLog";
import { getCurrentUserEmail } from "../storageKeys";
import {
  BudgetExceededError,
  BUDGET_CAP,
  DriveRangeTokenizer,
  HEAD_BYTES,
  RangeFetchNetworkError,
  TAIL_BYTES,
} from "../driveRangeTokenizer";
import {
  detectFormat,
  scanTailForMoov,
  walkMp4TopBoxes,
  mpegCbrDurationFromSize,
  readId3v2TagSize,
  ID3V2_HEADER_LEN,
  type AudioFormat,
} from "../audioFormat";
import {
  cacheTrackMetadata,
  classifyMetaError,
  getCacheEntry,
  getMemCacheEntry,
  mergeFullPicture,
  setFullPictureCache,
  setMetadataCache,
} from "./cache";
import {
  COVER_SLACK_BYTES,
  FALLBACK_AUDIO_FILENAME,
  HEAD_TAG_FETCH_BYTES,
  LARGE_FILE_THRESHOLD,
  METADATA_KEY_PREFIX,
  METADATA_NETWORK_COOLDOWN_MS,
  META_MODULE,
  REAL_METADATA_VERSION,
  TAG_BUDGET_MAX,
  UNKNOWN_ARTIST,
} from "./constants";
import { processCovers } from "./cover";
import type { CachedMetadata } from "./types";
import {
  hasEmbeddedDurationTag,
  makePlaceholder,
  stripExtension,
} from "./pipelineHelpers";

// ---- Per-file network cooldown (re-hang loop fix).
// Google Drive media endpoints have a known 30±5s first-byte delay under
// load (rclone forum threads 22681/8320). After ONE network failure for a
// fileId, every re-mount of the same card (scroll/filter re-render) used to
// re-spawn the range fetch and re-hang the UI for another ~30s before
// falling into the same placeholder. This map (fileId -> cooldown expiry)
// makes re-mounts inside the cooldown return the placeholder immediately
// WITHOUT touching the network — no spam of a Drive that just failed, no
// repeated hang. Unlike the app-wide circuit breaker (fail-fast after a
// throttle threshold), this is per-file: one slow file does not block the
// rest. forceNetwork bypasses the cooldown (manual retry via RefreshCw).
// Entries are pruned lazily on read; only recently-failed files are ever in
// the map, so it stays tiny and needs no timer.
const networkCooldownUntil = new Map<string, number>();

/**
 * Drops every per-file network cooldown. Called by clearAllMetadataCache so a
 * user-initiated cache clear restores a fully CLEAN state — without this,
 * files that failed once stay placeholder-blocked for up to
 * METADATA_NETWORK_COOLDOWN_MS even after the explicit reset.
 */
export function clearNetworkCooldown(): void {
  networkCooldownUntil.clear();
}

const logMetaWarn = (message: string, kind?: string): Promise<void> =>
  captureError({
    level: "warn",
    source: META_MODULE,
    message,
    ...(kind ? { kind } : {}),
  });

// FLAC metadata-block layout (xiph.org/flac/format.html): after the 4-byte
// 'fLaC' marker every block carries a 4-byte header — 1 flag/type byte (top
// bit = last-block flag, low 7 bits = type) + 24-bit big-endian length.
const FLAC_MARKER_LEN = 4;
const FLAC_BLOCK_HEADER_LEN = 4;
const FLAC_BLOCK_TYPE_MASK = 0x7f;
const FLAC_LAST_BLOCK_FLAG = 0x80;
const FLAC_BLOCK_TYPE_PICTURE = 6;

/**
 * End offset (exclusive) of the furthest PICTURE block whose header already
 * sits inside `head`, or 0 when no picture header is visible. Reads ONLY the
 * block headers from the already-fetched head — never the network — so a
 * picture spilling past the blind head still reveals its full extent through
 * its 24-bit length field. A header truncated by the head edge stops the walk
 * (the extent is unknowable without another fetch, and the chunked parse
 * below stays the fallback).
 */
function flacPictureEnd(head: Uint8Array): number {
  if (head.length < FLAC_MARKER_LEN + FLAC_BLOCK_HEADER_LEN) return 0;
  let pictureEnd = 0;
  let offset = FLAC_MARKER_LEN;
  while (offset + FLAC_BLOCK_HEADER_LEN <= head.length) {
    const flagType = head[offset] ?? 0;
    const type = flagType & FLAC_BLOCK_TYPE_MASK;
    const last = (flagType & FLAC_LAST_BLOCK_FLAG) !== 0;
    const len =
      ((head[offset + 1] ?? 0) << 16) |
      ((head[offset + 2] ?? 0) << 8) |
      (head[offset + 3] ?? 0);
    const blockEnd = offset + FLAC_BLOCK_HEADER_LEN + len;
    if (type === FLAC_BLOCK_TYPE_PICTURE && blockEnd > pictureEnd) {
      pictureEnd = blockEnd;
    }
    // A last-marked block ends the chain; a block running past the head edge
    // hides every later header (including any further PICTURE), so stop.
    if (last || blockEnd > head.length) break;
    offset = blockEnd;
  }
  return pictureEnd;
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
        let cachedData = cached.data;
        if (cachedData.pictureDataFull) {
          // Restart path: seed the memory LRU from the persisted full JPEG so
          // cards render sharp immediately. The mem entry still stays
          // full-free — the LRU is the single owner of full bytes (the seeded
          // value is re-attached by mergeFullPicture below).
          setFullPictureCache(fileId, cachedData.pictureDataFull);
          cachedData = { ...cachedData, pictureDataFull: null };
        }
        setMetadataCache(fileId, cachedData);
        return mergeFullPicture(fileId, cachedData);
      }
    } catch (e: unknown) {
      await logMetaWarn(
        `idb-read-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
      );
    }
  }

  // 1.5 DISK Check (seed offline import): <app_cache_dir>/metadata read via
  // Rust (read_metadata_disk). Imports land on disk so a mounted library
  // renders INSTANTLY — no range fetch, no IDB write (the disk is the single
  // source of truth for imported entries; IDB would duplicate them). Any
  // failure (no Tauri runtime, IO error, unparseable JSON) degrades to the
  // IDB/network pipeline below — never a hard error for the caller.
  if (!forceNetwork) {
    try {
      const diskJson = await invoke<string | null>("read_metadata_disk", {
        fileId,
      });
      const diskEntry = parseDiskMetadata(diskJson);
      if (diskEntry) {
        setMetadataCache(fileId, diskEntry);
        return diskEntry;
      }
    } catch (e: unknown) {
      await logMetaWarn(
        `disk-metadata-read-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
      );
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

  // Per-file network cooldown: a re-mount of a file whose last fetch failed
  // returns the placeholder immediately (no network, no cache pinning) until
  // the cooldown expires, then re-fetches naturally. forceNetwork bypasses
  // this so the manual retry always goes to the network.
  if (!forceNetwork) {
    const cooldownUntil = networkCooldownUntil.get(fileId);
    if (cooldownUntil !== undefined) {
      if (cooldownUntil > Date.now()) {
        return makePlaceholder(safeName, size);
      }
      // Lazy prune: the entry expired — drop it so the map never grows stale.
      networkCooldownUntil.delete(fileId);
    }
  }

  const isLargeFile = size > LARGE_FILE_THRESHOLD;
  // Fix E: for LARGE files the tokenizer's declared size is clamped to the
  // head region so music-metadata cannot seek the tail (ID3v1 / last-frame
  // Xing / moov-at-end) — a tail seek on a >100MB Drive file is exactly the
  // range fetch that timed out (metadata-fetch-failed storm on 152-297MB
  // files). Everything the app needs from a large file lives in the head:
  // ID3v2 tags + embedded cover + a Xing duration tag (when present).
  // Accepted consequence: no-Xing files — any size, since the slice-3
  // duration:false below — parse to duration 0 /
  // durationEstimated (the UI shows "–" via Fix F instead of a fake time);
  // a moov-at-tail m4a fails its parse (placeholder, no tail fetch).
  // Fix G: large CBR MP3s get their EXACT duration substituted from the real
  // size without opening a real-size tokenizer — see the duration block.
  const parseSize = isLargeFile ? Math.min(size, HEAD_BYTES) : size;

  let format: AudioFormat = "unknown";
  try {
    let tokenizer = new DriveRangeTokenizer(
      fileId,
      parseSize,
      signal ? { abortSignal: signal } : {},
    );

    // 2. Head fetch (one blind range request — 1.5MB or the whole file when
    //    smaller): format detection + m4a box walk + a typical ID3v2 tag
    //    body in the SAME request. The old 128KB head made every file whose
    //    tag spilled past it re-fetch the head region from byte 0.
    const head = await tokenizer.prefetchHead(
      Math.min(HEAD_TAG_FETCH_BYTES, parseSize),
    );
    format = detectFormat(head, name);

    if (format === "mp3") {
      // ID3v2 tags are read WHOLE by music-metadata (one readToken of the tag
      // body) — an unusually large tag (e.g. a 25MB cover) blows the default
      // 20MB fetch budget and nukes the whole entry. Raise the budget for the
      // tag region (capped at TAG_BUDGET_MAX); rare files only. The new
      // tokenizer re-fetches the head region — one extra request, accepted.
      // Large files keep the CLAMPED size here: a tag bigger than HEAD_BYTES
      // fails its parse (placeholder) instead of ever opening a full-size
      // tokenizer (too rare to spend a tail-capable fetch on).
      const tagSize = readId3v2TagSize(head);
      const tagBudgetNeeded = tagSize + ID3V2_HEADER_LEN + COVER_SLACK_BYTES;
      if (tagSize > 0 && tagBudgetNeeded > BUDGET_CAP) {
        tokenizer = new DriveRangeTokenizer(fileId, parseSize, {
          budgetBytes: Math.min(tagBudgetNeeded, TAG_BUDGET_MAX),
          ...(signal ? { abortSignal: signal } : {}),
        });
      }
      // Metadata-load latency: a tag extending past the blind head fetch was
      // read chunk-by-chunk (64KB per request) — a 600KB tag alone cost ~9
      // range requests, a 25MB tag ~400, all queued behind the app-wide
      // CONCURRENCY-3 semaphore. Prefetch ONLY the part past the blind head
      // (which already cached [0, HEAD_TAG_FETCH_BYTES)) so no byte is
      // re-fetched: HEAD_TAG_FETCH_BYTES is 64KB-aligned, so the range starts
      // exactly at the boundary. Best-effort: on budget or network failure
      // the prefetch is skipped and the parse re-reads the region chunked
      // exactly as before (the raised-budget retry / skipCovers fallbacks
      // are untouched). For LARGE files parseSize is clamped to HEAD_BYTES,
      // so prefetchEnd < HEAD_TAG_FETCH_BYTES → this never fires (byte
      // pattern identical to the pre-slice clamp; a tag that cannot fit the
      // clamped head keeps failing its parse into the placeholder — behavior
      // unchanged).
      if (tagSize > 0) {
        const prefetchEnd = Math.min(tagBudgetNeeded, parseSize);
        if (prefetchEnd > HEAD_TAG_FETCH_BYTES) {
          try {
            await tokenizer.prefetchRange(HEAD_TAG_FETCH_BYTES, prefetchEnd);
          } catch (e: unknown) {
            void logMetaWarn(
              `tag-prefetch-failed (fileId=${fileId}, size=${String(size)}): ${classifyMetaError(e).message}`,
            );
          }
        }
      }
    }

    if (format === "flac") {
      // A FLAC cover lives in a PICTURE block AFTER the vorbis comments, so a
      // ~2MB cover spills past the 1.5MB blind head and its remainder was read
      // chunk-by-chunk (64KB per request, ~8 requests queued behind the
      // app-wide CONCURRENCY-3 semaphore). The PICTURE header (with its
      // 24-bit length) sits at a tiny offset inside the head, so the spill
      // extent is known WITHOUT another fetch — prefetch ONLY the part past
      // the blind head (which already cached [0, HEAD_TAG_FETCH_BYTES)), the
      // exact mirror of the MP3 tag-remainder prefetch above. Best-effort: on
      // budget or network failure the parse re-reads the region chunked
      // exactly as before. Clamped to parseSize so large files (whose head is
      // only HEAD_BYTES) never fire this; the per-file budget itself is
      // enforced by prefetchRange's assertBudget (a BudgetExceededError lands
      // in the same warn-and-continue path, keeping the cover-degraded-budget
      // retry for 2x12MB FLACs intact).
      const pictureEnd = Math.min(flacPictureEnd(head), parseSize);
      if (pictureEnd > HEAD_TAG_FETCH_BYTES) {
        try {
          await tokenizer.prefetchRange(HEAD_TAG_FETCH_BYTES, pictureEnd);
        } catch (e: unknown) {
          void logMetaWarn(
            `picture-prefetch-failed (fileId=${fileId}, size=${String(size)}): ${classifyMetaError(e).message}`,
          );
        }
      }
    }

    if (format === "aac") {
      // ADTS has no embedded tags and music-metadata would scan the whole
      // stream for duration — skip parsing entirely, no further fetch.
      const placeholder = makePlaceholder(safeName, size);
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
        // duration:false: music-metadata only stream-scans frames for a
        // duration when this flag is set (MpegParser.js:419-421) — that scan
        // is the 51-request/255s range-fetch storm on VBR-no-Xing MP3s.
        // Durations still arrive without it: Xing/LAME are set
        // unconditionally (MpegParser.js:544-551) and CBR is derived from the
        // file size in finalize() (MpegParser.js:298-307, quit at 407-414).
        // Accepted loss: VBR-no-Xing MP3s (and Ogg tail-page scans) report
        // duration 0 / estimated instead of a scan-derived value.
        duration: false,
        // Skips the ID3v1/APE post-header EOF probe (AbstractID3Parser skips
        // it when tags were already found, hasAny()) — the probe range-fetched
        // the REAL file tail (fileInfo.size is the real size on non-clamped
        // files): one extra request per parse, gone. ID3v1-only files (no
        // ID3v2 tag → hasAny() false) still probe and parse their tag.
        skipPostHeaders: true,
      });
    } catch (e: unknown) {
      if (e instanceof BudgetExceededError) {
        // Expected degradation, not a failure: the skipCovers retry below
        // salvages the text metadata, so this is informational by design
        // (logMetaWarn pins level "warn" — this site deliberately logs lower).
        await captureError({
          level: "info",
          source: META_MODULE,
          message: `cover-degraded-budget (fileId=${fileId}, size=${String(size)}): cover read exceeded range budget, cover skipped, text metadata kept (entry v:8): ${classifyMetaError(e).message}`,
          kind: "BudgetExceededError",
        });
        // Re-parse with covers skipped on a FRESH tokenizer: the old one has
        // exhausted its fetch budget (even its tail-scan would throw again).
        // A fresh budget plus ignore()-advancing past the cover reads only the
        // tag region — no full-file download. The retry needs the raised
        // TAG_BUDGET_MAX (32MB) budget: skipCovers still parses the whole
        // ID3v2 tag up-front, so a 20-32MB tag blows the 20MB default on the
        // second attempt too and falls to the placeholder.
        const retryTokenizer = new DriveRangeTokenizer(fileId, parseSize, {
          ...(signal ? { abortSignal: signal } : {}),
          budgetBytes: TAG_BUDGET_MAX,
        });
        metadata = await parseFromTokenizer(retryTokenizer, {
          skipCovers: true,
          // Same duration:false rationale as the initial parse above — the
          // retry must not re-introduce the audio-region scan.
          duration: false,
          skipPostHeaders: true,
        });
      } else {
        throw e;
      }
    }

    const parsedDuration = metadata.format.duration;
    const hasEmbeddedTag = hasEmbeddedDurationTag(head, format);
    // Fix G: for a large CBR MP3 the parser derives the duration from the
    // CLAMPED size (bogus seconds) — unless the head carries a Xing/Info tag.
    // Substitute the exact duration computed from the REAL size instead. The
    // math mirrors music-metadata's finalize() CBR path (same frame-size and
    // samples-per-frame tables, same rounding, same 4 frames the parser
    // walks), so the value equals what a real-size parse would produce — but
    // the tokenizer stays clamped, so music-metadata never range-fetches the
    // tail (ParserFactory scans for ID3v1/APEv2 before parsing even starts).
    // Known limitation: a real ID3v1 tag at the very end of the file is not
    // visible in the clamped view; its 128 bytes are never subtracted, which
    // can shift the frame count by one (≈26ms) on some files.
    const cbrDuration = isLargeFile
      ? mpegCbrDurationFromSize(head, format, size)
      : null;
    const hasRealDuration =
      typeof parsedDuration === "number" &&
      Number.isFinite(parsedDuration) &&
      parsedDuration > 0 &&
      // Fix E: on a clamped parse only an embedded Xing/Info tag yields a
      // trustworthy duration — anything else was derived from the clamped
      // file size (CBR) or the EOF frame count (VBR) and is bogus seconds.
      // Fix G: the size-derived CBR duration above is trusted too.
      (!isLargeFile || hasEmbeddedTag || cbrDuration !== null);
    const trustedDuration = hasEmbeddedTag ? parsedDuration : cbrDuration;

    const entry: CachedMetadata = {
      title: metadata.common.title ?? stripExtension(safeName),
      artist: metadata.common.artist ?? UNKNOWN_ARTIST,
      album: metadata.common.album ?? "",
      duration: hasRealDuration ? (trustedDuration ?? parsedDuration) : 0,
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
    //    and a full variant (≤2000px; memory LRU + IDB-persisted when JPEG).
    //    A failing picture NEVER drops the text entry — processCovers warns
    //    and skips, leaving entry v:8 fully populated.
    await processCovers(fileId, entry, metadata.common.picture);

    // 4. m4a faststart check: moov must precede mdat or the file cannot be
    //    streamed progressively (non-faststart). A moov found in the tail
    //    confirms the layout; its absence means no moov anywhere — both are
    //    marked streamUnplayable. SKIPPED for large files (Fix E): their
    //    parse is head-clamped, so a moov-at-tail never exists in this view —
    //    scanning the real tail would re-open the exact timeout the clamp
    //    exists to avoid (streamUnplayable is not marked for them).
    let streamUnplayable = false;
    if (format === "m4a" && !isLargeFile) {
      // The walk must keep seeing the OLD 128KB head window: the blind fetch
      // now covers up to 1.5MB, and a moov reached inside the wider head (a
      // small non-faststart file whose moov sits past 128KB) would flip
      // moovBeforeMdat and silently un-mark files the old contract flagged.
      // Slice 2 keeps the streamUnplayable semantics byte-identical.
      const walk = walkMp4TopBoxes(
        head.subarray(0, Math.min(HEAD_BYTES, head.length)),
        size,
      );
      if (walk.mdatBeforeMoov && !walk.moovBeforeMdat) {
        streamUnplayable = true;
        // The cached entry must carry the flag so the player's pre-play gate
        // (usePlayer) sees it without re-parsing; cacheTrackMetadata below
        // persists this entry to memory + IDB.
        entry.streamUnplayable = true;
        try {
          const tailStart = Math.max(0, size - TAIL_BYTES);
          try {
            // Metadata-load latency: scanning a 1MB tail chunk-by-chunk cost
            // 16 range requests (64KB each) behind the CONCURRENCY-3
            // semaphore. Prefetch the tail in ONE request; the scan below
            // then reads it from the seeded cache.
            await tokenizer.prefetchRange(tailStart, size);
          } catch (e: unknown) {
            // Best-effort optimization only: a failed prefetch must not
            // change the tail scan — readRange below re-reads the region
            // chunked, exactly as before (same scan outcome, more requests).
            void logMetaWarn(
              `m4a-tail-prefetch-failed (fileId=${fileId}, size=${String(size)}): ${classifyMetaError(e).message}`,
            );
          }
          const tail = await tokenizer.readRange(tailStart, size);
          if (scanTailForMoov(tail, size) === null) {
            await logMetaWarn(
              `m4a-tail-scan: no moov box found at the end of file (fileId=${fileId}, size=${String(size)})`,
            );
          }
        } catch (e: unknown) {
          await logMetaWarn(
            `m4a-tail-scan-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
          );
        }
      }
    }

    // 5. Non-faststart m4a: persist the flag on the files row so the player
    //    can avoid streaming it (schema field is pre-existing, untouched).
    if (streamUnplayable) {
      try {
        // Compound PK (schema v10): [userEmail, id].
        await db.files.update([getCurrentUserEmail(), fileId], {
          metadata: { format, streamUnplayable: true },
        });
      } catch (e: unknown) {
        await logMetaWarn(
          `files-metadata-write-failed (fileId=${fileId}): ${classifyMetaError(e).message}`,
        );
      }
    }

    // 6. IDB + memory cache (setCache keeps the generation guard + score rules)
    cacheTrackMetadata(fileId, entry);
    return entry;
  } catch (e: unknown) {
    await logMetaWarn(
      `metadata-fetch-failed (fileId=${fileId}, size=${String(size)}, format=${format}): ${classifyMetaError(e).message}`,
      classifyMetaError(e).name,
    );
    const placeholder = makePlaceholder(safeName, size);
    // A caller abort (scroll unmounted the card mid-fetch) surfaces here as a
    // RangeFetchNetworkError — the tokenizer classifies the AbortError as
    // transient so it skips retries and the circuit breaker — but Drive is
    // perfectly healthy. Pinning the 60s cooldown for a deliberate
    // cancellation made the card re-mount as a stuck placeholder for a full
    // minute despite zero network trouble. Mirror the network branch's
    // no-pin semantics WITHOUT the cooldown: return the placeholder to THIS
    // caller only; the next mount re-fetches immediately.
    if (signal?.aborted === true) {
      return placeholder;
    }
    // A transient network/timeout failure must NOT pin the v:9 placeholder
    // into the memory cache — that made every card show 00:00:00 until app
    // reload (the mem entry shadows any later fetch). Deterministic failures
    // (parse errors, RangeNotSupported, budget, unknown size) still cache:
    // re-fetching those can only fail again. A network failure returns the
    // placeholder to THIS caller but the next getTrackMetadata re-fetches —
    // gated by the per-file cooldown so the re-fetch does not re-hang the
    // card while Drive is still slow.
    if (e instanceof RangeFetchNetworkError) {
      networkCooldownUntil.set(
        fileId,
        Date.now() + METADATA_NETWORK_COOLDOWN_MS,
      );
    } else {
      setMetadataCache(fileId, placeholder);
    }
    return placeholder;
  }
}

/**
 * Validates a metadata JSON read from the disk-first source (seed offline
 * import). Returns null for anything that is not a well-formed v:8 entry
 * (wrong version, missing required fields, invalid JSON) so the caller can
 * fall through to the IDB/network pipeline — a corrupt or stale file must
 * never hard-fail a card.
 *
 * Required: v === REAL_METADATA_VERSION (8), title is a non-empty string,
 * duration is a finite number. pictureData/pictureDataFull are forced to
 * null (disk entries carry no embedded bytes — the cover renders through the
 * drplay:// GET from the Rust cover cache) and coverOnDisk is set to true.
 * Extended fields are optional and type-checked individually; an invalid
 * optional field is dropped, not fatal.
 */
function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function pickFinite(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function parseDiskMetadata(
  raw: string | null | undefined,
): CachedMetadata | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== REAL_METADATA_VERSION) return null;
  const title = pickString(obj, "title");
  if (title === undefined || title.length === 0) return null;
  const duration = pickFinite(obj, "duration");
  if (duration === undefined) return null;
  const entry: CachedMetadata = {
    title,
    artist: pickString(obj, "artist") ?? UNKNOWN_ARTIST,
    album: pickString(obj, "album") ?? "",
    duration,
    durationEstimated:
      typeof obj.durationEstimated === "boolean"
        ? obj.durationEstimated
        : !(duration > 0),
    pictureData: null,
    pictureDataFull: null,
    v: REAL_METADATA_VERSION,
    coverOnDisk: true,
  };
  const pictureFormat = pickString(obj, "pictureFormat");
  if (pictureFormat !== undefined) entry.pictureFormat = pictureFormat;
  const bitrate = pickFinite(obj, "bitrate");
  if (bitrate !== undefined) entry.bitrate = bitrate;
  const size = pickFinite(obj, "size");
  if (size !== undefined) entry.size = size;
  const genre = pickString(obj, "genre");
  if (genre !== undefined) entry.genre = genre;
  const year = pickFinite(obj, "year");
  if (year !== undefined) entry.year = year;
  const trackNumber = pickFinite(obj, "trackNumber");
  if (trackNumber !== undefined) entry.trackNumber = trackNumber;
  const albumArtist = pickString(obj, "albumArtist");
  if (albumArtist !== undefined) entry.albumArtist = albumArtist;
  const sampleRate = pickFinite(obj, "sampleRate");
  if (sampleRate !== undefined) entry.sampleRate = sampleRate;
  const bitDepth = pickFinite(obj, "bitDepth");
  if (bitDepth !== undefined) entry.bitDepth = bitDepth;
  const channels = pickFinite(obj, "channels");
  if (channels !== undefined) entry.channels = channels;
  if (typeof obj.streamUnplayable === "boolean") {
    entry.streamUnplayable = obj.streamUnplayable;
  }
  return entry;
}

export { getTrackMetadataImpl };
