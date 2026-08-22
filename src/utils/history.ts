import Dexie from "dexie";
import { db } from "../db/db";
import type { Track } from "../types";
import { ROOT_FOLDER_ID } from "./driveConstants";
import { captureError } from "./errorLog";
import { METADATA_KEY_PREFIX, V_PLACEHOLDER } from "./metadata";
import { getCurrentUserEmail } from "./storageKeys";

const RECENT_CAP = 1000;
const PLAY_COUNT_CAP = 1000;
const FOLDER_VISIT_CAP = 1000;
const HEAVY_ROTATION_LIMIT = 10;
const RANDOM_DISCOVERIES_LIMIT = 12;
const MOST_VISITED_FOLDERS_LIMIT = 4;
const HISTORY_MODULE = "history";

function classifyHistoryError(err: unknown): string {
  const name = err instanceof Error ? err.name : "unknown";
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

export interface PlayCountEntry {
  track: Track;
  count: number;
}

export interface FolderVisitEntry {
  id: string;
  name: string;
  count: number;
  lastVisited: number;
}

/**
 * Record a play: upsert the track into the recently-played list (deduped by
 * id, newest first) and bump its per-user play count, then prune both tables
 * back to their caps so per-user history cannot grow unbounded on disk. Fires
 * a 'recent-updated' window event so live history UI re-renders. Failures are
 * logged, never thrown — a play must not crash the player.
 * @param track The track that just started playing.
 */
export async function recordPlay(track: Track) {
  const email = getCurrentUserEmail();
  try {
    await db.transaction(
      "rw",
      [db.recentTracks, db.playCounts, db.errorLogs],
      async () => {
        // Compound PK [userEmail+id] (schema v7): the row is addressable by its
        // exact key — no need to scan + filter by id like the old raw-id schema.
        const existing = await db.recentTracks.get([email, track.id]);
        if (existing) {
          await db.recentTracks.delete([email, track.id]);
        }
        await db.recentTracks.put({
          id: track.id,
          track,
          userEmail: email,
          createdAt: Date.now(),
        });
        await pruneRecentTracks(email);

        const countRow = await db.playCounts.get([email, track.id]);
        const nextCount = (countRow?.count || 0) + 1;
        await db.playCounts.put({
          id: track.id,
          track,
          count: nextCount,
          userEmail: email,
        });
        await prunePlayCounts(email);
      },
    );
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `recordPlay-failed: ${classifyHistoryError(e)}`,
    });
  }

  window.dispatchEvent(new Event("recent-updated"));
}

// Keeps playCounts bounded at PLAY_COUNT_CAP rows per user on disk. Rows are
// one-per-track upserts keyed by track id, so growth equals the number of
// distinct tracks ever played — without a cap the table (and every full-table
// read in getHeavyRotation) grows forever. Runs after every play: evicts the
// least-played rows first via the [userEmail+count] index (schema v6) — those
// are exactly the rows a top-10 by count read would never return. When under
// the cap this is a no-op after one count().
async function prunePlayCounts(email: string): Promise<void> {
  try {
    const range = db.playCounts
      .where("[userEmail+count]")
      .between([email, Dexie.minKey], [email, Dexie.maxKey]);
    const total = await range.count();
    const excess = total - PLAY_COUNT_CAP;
    if (excess <= 0) return;
    const evict = await range.limit(excess).toArray();
    if (evict.length === 0) return;
    // Compound PK [userEmail+id] (schema v7) — bulkDelete needs full keys.
    await db.playCounts.bulkDelete(
      evict.map((r): [string, string] => [r.userEmail, r.id]),
    );
  } catch (e: unknown) {
    // Prune failure must not lose the play record — log with context only.
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `playCounts-prune-failed: ${classifyHistoryError(e)}`,
    });
  }
}

// Keeps recentTracks bounded at RECENT_CAP per user on disk (the read path
// already caps at RECENT_CAP, but rows were never pruned at write time, so
// the table grew unbounded over time). Runs on every write: each new unique
// track adds at most one row (recordPlay dedupes by id), so steady-state the
// excess above the cap is tiny and only a handful of oldest rows are evicted.
// Uses the [userEmail+createdAt] index (schema v5): a native range count plus
// a short offset skip — never reads the whole table. When the table is under
// the cap this is a no-op after one count().
async function pruneRecentTracks(email: string): Promise<void> {
  try {
    const range = db.recentTracks
      .where("[userEmail+createdAt]")
      .between([email, Dexie.minKey], [email, Dexie.maxKey]);
    const total = await range.count();
    const excess = total - RECENT_CAP;
    if (excess <= 0) return;
    // 0-based: the first row to keep is the excess-th oldest. Only skip
    // `excess` entries (small in practice) instead of offset(RECENT_CAP).
    const cutoff = await range.offset(excess).first();
    if (!cutoff) return;
    // Exclusive upper bound: rows sharing the cutoff's exact timestamp are as
    // recent as the cutoff row (incl. the just-written play) and must survive.
    await db.recentTracks
      .where("[userEmail+createdAt]")
      .between([email, Dexie.minKey], [email, cutoff.createdAt], false, false)
      .delete();
  } catch (e: unknown) {
    // Prune failure must not lose the play record — log with context only.
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `recentTracks-prune-failed: ${classifyHistoryError(e)}`,
    });
  }
}

/**
 * The user's play history, newest first, deduped by track id and capped at
 * RECENT_CAP. Scoped to the current user's email. Returns [] (logged) when
 * the read fails rather than throwing.
 */
export async function getRecentlyPlayed(): Promise<Track[]> {
  const email = getCurrentUserEmail();
  try {
    const rows = await db.recentTracks
      .where("userEmail")
      .equals(email)
      .toArray();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const deduped: Track[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      deduped.push(row.track);
    }
    return deduped.slice(0, RECENT_CAP);
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `getRecentlyPlayed-failed: ${classifyHistoryError(e)}`,
    });
    return [];
  }
}

/**
 * The current user's top tracks by play count (top 10, straight from the
 * [userEmail+count] index so it never materializes the whole table) — the
 * "on repeat" / heavy rotation section. Returns [] (logged) on failure.
 */
export async function getHeavyRotation(): Promise<Track[]> {
  const email = getCurrentUserEmail();
  try {
    // Top 10 by count straight from the [userEmail+count] index (schema v6):
    // a reversed compound range capped at 10 — never materializes the whole
    // table in memory (previously every call loaded every playCounts row).
    const rows = await db.playCounts
      .where("[userEmail+count]")
      .between([email, Dexie.minKey], [email, Dexie.maxKey])
      .reverse()
      .limit(HEAVY_ROTATION_LIMIT)
      .toArray();
    return rows.map((row) => row.track);
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `getHeavyRotation-failed: ${classifyHistoryError(e)}`,
    });
    return [];
  }
}

/**
 * Random sample of tracks the user has real metadata for (picks keys from the
 * metadata cache with real, non-placeholder entries and shuffles them) — the
 * "discover something" row. Track titles are the generic placeholder until a
 * fetch fills them in. Returns [] when nothing cached, or on failure.
 */
export async function getRandomDiscoveries(): Promise<Track[]> {
  try {
    // Key-only scan: the metadata-key prefix is applied to the primary key
    // inside IndexedDB (':id'), so building the candidate list deserializes
    // no entry payloads. The v predicate lives inside each entry value, so
    // candidate rows are validated lazily while walking the shuffled keys —
    // the walk stops as soon as RANDOM_DISCOVERIES_LIMIT real entries are
    // collected and the whole table never materializes in memory at once.
    const candidateKeys = await db.metadataCache
      .where(":id")
      .startsWith(METADATA_KEY_PREFIX)
      .primaryKeys();
    if (candidateKeys.length === 0) return [];

    const shuffled = [...candidateKeys];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = shuffled[i];
      const b = shuffled[j];
      if (a === undefined || b === undefined) continue;
      [shuffled[i], shuffled[j]] = [b, a];
    }

    const tracks: Track[] = [];
    for (const key of shuffled) {
      if (tracks.length >= RANDOM_DISCOVERIES_LIMIT) break;
      // A row can vanish between the key scan and this get — skip it.
      const row = await db.metadataCache.get(key);
      if (!row) continue;
      const entry = row.entry as { data?: { v: number } } | undefined;
      const isValid =
        entry !== undefined &&
        entry.data !== undefined &&
        entry.data.v < V_PLACEHOLDER;
      if (!isValid) continue;
      tracks.push({
        id: key.replace(METADATA_KEY_PREFIX, ""),
        title: "Audio Track",
        artist: "",
        streamUrl: "",
      });
    }
    return tracks;
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `getRandomDiscoveries-failed: ${classifyHistoryError(e)}`,
    });
    return [];
  }
}

/**
 * Record that the user opened a folder: upsert its per-user visit count and
 * last-visited time, pruning back to FOLDER_VISIT_CAP afterwards. The root
 * folder is ignored (visiting root is the default state, not a signal).
 * Failures are logged, never thrown.
 * @param folderId Drive id of the visited folder.
 * @param folderName Its display name at visit time (stored for later display).
 */
export async function recordFolderVisit(folderId: string, folderName: string) {
  if (folderId === ROOT_FOLDER_ID) return;
  const email = getCurrentUserEmail();
  try {
    await db.transaction("rw", [db.folderVisits, db.errorLogs], async () => {
      // Compound PK [userEmail+id] (schema v7): the row is addressable by its
      // exact key — no need to scan + filter by id like the old raw-id schema.
      const existing = await db.folderVisits.get([email, folderId]);
      const now = Date.now();
      const count = (existing?.count || 0) + 1;
      await db.folderVisits.put({
        id: folderId,
        name: folderName,
        count,
        lastVisited: now,
        userEmail: email,
      });
      await pruneFolderVisits(email);
    });
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `recordFolderVisit-failed: ${classifyHistoryError(e)}`,
    });
  }
}

// Keeps folderVisits bounded at FOLDER_VISIT_CAP rows per user on disk. Rows
// are one-per-folder upserts keyed by folder id, so growth equals the number
// of distinct folders ever visited — unbounded otherwise. Runs after every
// visit: evicts the least-visited rows first via the [userEmail+count] index
// (schema v6) — those are never top-4 candidates for getMostVisitedFolders.
// When under the cap this is a no-op after one count().
async function pruneFolderVisits(email: string): Promise<void> {
  try {
    const range = db.folderVisits
      .where("[userEmail+count]")
      .between([email, Dexie.minKey], [email, Dexie.maxKey]);
    const total = await range.count();
    const excess = total - FOLDER_VISIT_CAP;
    if (excess <= 0) return;
    const evict = await range.limit(excess).toArray();
    if (evict.length === 0) return;
    // Compound PK [userEmail+id] (schema v7) — bulkDelete needs full keys.
    await db.folderVisits.bulkDelete(
      evict.map((r): [string, string] => [r.userEmail, r.id]),
    );
  } catch (e: unknown) {
    // Prune failure must not lose the visit record — log with context only.
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `folderVisits-prune-failed: ${classifyHistoryError(e)}`,
    });
  }
}

/**
 * The current user's most-visited folders (top 4, ties broken by recency) —
 * the quick-navigation row. Returns [] (logged) on failure.
 */
export async function getMostVisitedFolders(): Promise<FolderVisitEntry[]> {
  const email = getCurrentUserEmail();
  try {
    const rows = await db.folderVisits
      .where("userEmail")
      .equals(email)
      .toArray();
    return rows
      .sort((a, b) => b.count - a.count || b.lastVisited - a.lastVisited)
      .slice(0, MOST_VISITED_FOLDERS_LIMIT)
      .map((r) => ({
        id: r.id,
        name: r.name,
        count: r.count,
        lastVisited: r.lastVisited,
      }));
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: HISTORY_MODULE,
      message: `getMostVisitedFolders-failed: ${classifyHistoryError(e)}`,
    });
    return [];
  }
}
