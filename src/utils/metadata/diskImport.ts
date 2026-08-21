import { REAL_METADATA_VERSION, UNKNOWN_ARTIST } from "./constants";
import type { CachedMetadata } from "./types";

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
  return entry;
}
