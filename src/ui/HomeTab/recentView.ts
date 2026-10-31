import type { Track } from "../../types";

/**
 * A Track as displayed by the Home full views (FullRecentView), optionally
 * carrying a real view date in epoch milliseconds:
 * - Recent Files source: the last-played timestamp (RecentTrackRow.createdAt).
 * - Recently Added source: the Drive file's modifiedTime.
 *
 * Narrowly scoped view model — deliberately NOT a field on core Track, which
 * is persisted verbatim in db.recentTracks/db.playCounts (adding a field there
 * would leak view concerns into every persisted session). Absent viewDate
 * means "no real date known" — sorting falls back to array order and the date
 * cell shows "—".
 */
export type RecentItem = Track & { viewDate?: number | undefined };

/**
 * Convert a view-layer RecentItem into a bare playback Track by stripping
 * ONLY viewDate (rest-destructure — every other field passes through
 * untouched). This is the playback boundary: FullRecentView hands the result
 * to onPlay, so the view-only timestamp can never reach the in-memory queue
 * or the verbatim-persisted history rows (recentTracks/playCounts). Returns
 * a new object; the input RecentItem is never mutated.
 */
export function toPlaybackTrack(item: RecentItem): Track {
  // The underscore-prefixed rest sibling IS the strip; the binding is unused
  // by design (rest-destructure removal, not a value read).
  // prettier-ignore
  const { viewDate: _viewDate, ...track } = item; // eslint-disable-line @typescript-eslint/no-unused-vars
  return track;
}

/**
 * The name Recent rows are searched and sorted by: the full Drive filename
 * (originalName, extension included) when present and non-empty, falling
 * back to the listing title otherwise. Must stay in sync with SongCard's
 * displayed name so what the user sees is what matches the query.
 */
export function recentDisplayName(item: RecentItem): string {
  return item.originalName !== undefined && item.originalName !== ""
    ? item.originalName
    : item.title;
}
