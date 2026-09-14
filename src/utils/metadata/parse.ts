import { invoke } from "@tauri-apps/api/core";
import {
  classifyMetaError,
  getCacheEntry,
  mergeFullPicture,
  setFullPictureCache,
  setMetadataCache,
} from "./cache";
import {
  METADATA_KEY_PREFIX,
  REAL_METADATA_VERSION,
  UNKNOWN_ARTIST,
} from "./constants";
import { logMetaWarn } from "./pipelineHelpers";
import type { CachedMetadata } from "./types";

export async function readCachedEntry(
  fileId: string,
  forceNetwork: boolean,
): Promise<CachedMetadata | null> {
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
          // A corrupt row (isCacheEntry guards only the envelope) must not
          // poison the LRU: a non-Uint8Array value has no byteLength (NaN
          // byte accounting) and an empty array renders a 0-byte cover
          // instead of falling back to the thumb — seed only real bytes,
          // then drop the field either way.
          if (
            cachedData.pictureDataFull instanceof Uint8Array &&
            cachedData.pictureDataFull.byteLength > 0
          ) {
            setFullPictureCache(fileId, cachedData.pictureDataFull);
          }
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

  return null;
}

/**
 * Validates a metadata JSON read from the disk-first source (seed offline
 * import). Returns null for anything that is not a well-formed v:8 entry
 * (wrong version, missing required fields, invalid JSON) so the caller can
 * fall through to the IDB/network pipeline — a corrupt or stale file must
 * never hard-fail a card.
 *
 * Required: v === REAL_METADATA_VERSION (8), title is a non-empty string
 * (whitespace-only rejected), duration is a finite number.
 * pictureData/pictureDataFull are forced to null (disk entries carry no
 * embedded bytes — the cover renders through the drplay:// GET from the Rust
 * cover cache) and coverOnDisk is set to true. Extended fields are optional,
 * type-checked individually and dropped when outside their domain; an invalid
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

/**
 * pickFinite + a domain predicate: a finite number outside its valid range
 * (or fractional where an integer is required) is dropped like a wrong type —
 * optional fields are best-effort, never fatal.
 */
function pickNumber(
  obj: Record<string, unknown>,
  key: string,
  valid: (value: number) => boolean,
): number | undefined {
  const value = pickFinite(obj, key);
  return value !== undefined && valid(value) ? value : undefined;
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
  if (title === undefined || title.trim().length === 0) return null;
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
  const bitrate = pickNumber(obj, "bitrate", (n) => n > 0);
  if (bitrate !== undefined) entry.bitrate = bitrate;
  const size = pickNumber(obj, "size", (n) => n > 0);
  if (size !== undefined) entry.size = size;
  const genre = pickString(obj, "genre");
  if (genre !== undefined) entry.genre = genre;
  const year = pickNumber(obj, "year", Number.isInteger);
  if (year !== undefined) entry.year = year;
  const trackNumber = pickNumber(obj, "trackNumber", Number.isInteger);
  if (trackNumber !== undefined) entry.trackNumber = trackNumber;
  const albumArtist = pickString(obj, "albumArtist");
  if (albumArtist !== undefined) entry.albumArtist = albumArtist;
  const sampleRate = pickNumber(obj, "sampleRate", (n) => n > 0);
  if (sampleRate !== undefined) entry.sampleRate = sampleRate;
  const bitDepth = pickNumber(obj, "bitDepth", (n) => n > 0);
  if (bitDepth !== undefined) entry.bitDepth = bitDepth;
  const channels = pickNumber(
    obj,
    "channels",
    (n) => n > 0 && Number.isInteger(n),
  );
  if (channels !== undefined) entry.channels = channels;
  if (typeof obj.streamUnplayable === "boolean") {
    entry.streamUnplayable = obj.streamUnplayable;
  }
  return entry;
}
