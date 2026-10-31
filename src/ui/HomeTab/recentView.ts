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
