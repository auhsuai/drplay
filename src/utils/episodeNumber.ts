/**
 * Episode number read out of a media FILENAME.
 *
 * A queue full of episodes of the same series is unusable when every row shows
 * the same truncated name — the number is the only thing that tells them apart.
 * Track titles are the raw Drive filename, so the number has to be recovered
 * from the release name.
 *
 * The patterns are tried in DECREASING confidence, the order media servers use
 * (Plex/Emby/Kodi agree on it), because the cheap patterns are the ambiguous
 * ones: a bare `2019` is a release year far more often than episode 2019.
 *
 * Case-insensitive throughout — Drive preserves the uploader's capitalization
 * and fansubbers use both `- 05` and `- 05v2` in the same folder.
 */

/** Trailing file extension, dropped so `Name.05.mkv` cannot match the `.05`. */
const EXTENSION = /\.[a-z0-9]{2,5}$/i;

/** `S01E05`, `S1E5`, `S01.E05`, `s01_e05`. */
const SEASON_EPISODE = /\bs\d{1,2}[\s._-]*e(\d{1,3})\b/gi;

/** `1x05`, `01x05`, `1x001` — the older alternative to S##E##. */
const SEASON_EPISODE_X = /\b\d{1,2}x(\d{2,3})\b/gi;

/**
 * `Episode 12`, `Ep.05`, `E05`. The bare `e` only matches at a word boundary,
 * so it never fires inside a codec name (`HEVC`, `x264`, `DDP5.1`).
 */
const KEYWORD = /\b(?:episode|ep|e)[\s._-]?(\d{1,3})(?![\dx])/gi;

/** `第05話`, `05話` — Japanese fansub numbering. */
const JAPANESE = /(?:第\s*)?(\d{1,4})\s*話/g;

/** `#05` — the other Japanese fansub convention. */
const HASH_NUMBER = /(?:^|\s)#\s*(\d{1,4})(?:v\d)?(?=[\s._-]|$)/g;

/**
 * Absolute numbering, the anime default: `Name - 05 [720p]`, `Name.05.720p`,
 * `Name - 05v2`. Lowest confidence, hence last.
 *
 * The lookahead is what keeps the technical tags out: `1080p` is followed by
 * `p`, and a CRC32 like `[CF1029D9]` is preceded by a hex letter — neither is
 * delimited the way an episode number is. `-` is a delimiter on both sides so
 * a batch range (`- 01-12`) reads as its FIRST episode.
 */
const ABSOLUTE = /(?:^|[\s\-_.])(\d{2,4})(?:v\d)?(?=[\s._-]|$)/g;

const PATTERNS: ReadonlyArray<RegExp> = [
  SEASON_EPISODE,
  SEASON_EPISODE_X,
  KEYWORD,
  JAPANESE,
  HASH_NUMBER,
  ABSOLUTE,
];

/**
 * Resolution dimensions that survive the delimiter rules (`1920 x 1080` has a
 * space after `1920`) and would otherwise read as an episode.
 */
const RESOLUTION_NUMBERS: ReadonlySet<string> = new Set([
  "240",
  "360",
  "480",
  "540",
  "576",
  "720",
  "1080",
  "1440",
  "1920",
  "2160",
  "3840",
]);

/**
 * Reject the two false positives a bare number cannot avoid: a four-digit year
 * (`Movie.Name.2019.1080p`) and a resolution. A zero-padded four-digit value is
 * kept, because that is absolute numbering (`Name - 0189 [720p]`), never a year.
 */
function isPlausible(raw: string): boolean {
  if (RESOLUTION_NUMBERS.has(raw)) return false;
  if (raw.length === 4 && !raw.startsWith("0")) {
    const value = Number(raw);
    if (value >= 1900 && value <= 2099) return false;
  }
  return true;
}

/**
 * The episode number as it appears in the name (`"05"`, `"038"`, `"12.5"`'s
 * integer part), or null when nothing in the name is confidently an episode.
 *
 * Null is the common answer for movies, music and specials, and the caller is
 * expected to simply not render a badge then.
 *
 * A name alone cannot tell `Album - 10 Tracks` from an episode 10 — that is
 * why the caller gates on the file being a VIDEO before showing a badge.
 */
export function episodeNumberFromName(name: string): string | null {
  const base = name.replace(EXTENSION, "");
  for (const pattern of PATTERNS) {
    for (const match of base.matchAll(pattern)) {
      const raw = match[1];
      if (raw !== undefined && isPlausible(raw)) return raw;
    }
  }
  return null;
}
