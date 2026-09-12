import { parseFromTokenizer } from "music-metadata";
import type { IAudioMetadata } from "music-metadata";
import { db } from "../../db/db";
import { captureError } from "../errorLog";
import { getCurrentUserEmail } from "../storageKeys";
import {
  BudgetExceededError,
  DriveRangeTokenizer,
  HEAD_BYTES,
  RangeFetchNetworkError,
} from "../driveRangeTokenizer";
import {
  detectFormat,
  walkMp4TopBoxes,
  mpegCbrDurationFromSize,
  type AudioFormat,
} from "../audioFormat";
import {
  cacheTrackMetadata,
  classifyMetaError,
  getMemCacheEntry,
  mergeFullPicture,
  setMetadataCache,
} from "./cache";
import {
  FALLBACK_AUDIO_FILENAME,
  HEAD_TAG_FETCH_BYTES,
  LARGE_FILE_THRESHOLD,
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
  logMetaWarn,
  makePlaceholder,
  stripExtension,
} from "./pipelineHelpers";
import { networkCooldownUntil } from "./cooldown";
import { readCachedEntry } from "./parse";
export { parseDiskMetadata } from "./parse";
import {
  prefetchAndScanM4aTail,
  prefetchFlacPictureRemainder,
  prepareMp3Tokenizer,
} from "./prefetch";

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

  const cachedEntry = await readCachedEntry(fileId, forceNetwork);
  if (cachedEntry) {
    return cachedEntry;
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
      tokenizer = await prepareMp3Tokenizer(
        tokenizer,
        fileId,
        size,
        head,
        parseSize,
        signal,
      );
    }

    if (format === "flac") {
      await prefetchFlacPictureRemainder(
        tokenizer,
        fileId,
        size,
        head,
        parseSize,
      );
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
        await prefetchAndScanM4aTail(tokenizer, fileId, size);
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

export { getTrackMetadataImpl };
