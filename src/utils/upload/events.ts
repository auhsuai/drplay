import { ROOT_FOLDER_ID } from "../driveConstants";
import { captureError } from "../errorLog";
import { MODULE, PROGRESS_NOTIFY_INTERVAL_MS, describeError } from "./errors";
import type { InternalEntry, UploadEntry } from "./types";

/**
 * Card-level upload presentation state (slice 6):
 * - 'uploading'        → the item itself is being uploaded (dim + spinner)
 * - 'parent-uploading' → a child of this folder is uploading (spinner only,
 *                        the folder already exists on Drive — no dim)
 * - 'uploaded'         → the item finished uploading recently (green check,
 *                        dismissed on play or after UPLOADED_TINT_MS)
 * - 'none'             → idle
 */
export type UploadState =
  "none" | "uploading" | "parent-uploading" | "uploaded";

// How long the "just uploaded" green check stays visible before the row
// returns to the idle MoreMenu state.
const UPLOADED_TINT_MS = 10_000;
// Ids (entry or drive id) that finished uploading recently — presentation
// only, cleared by timer or when the user plays the item.
const recentlyDoneIds = new Set<string>();

// Subscribers to upload-state changes; notify() walks this set (a throwing
// subscriber must not break the loop).
const subscribers = new Set<() => void>();

// Progress notify is coalesced PER ENTRY through trailing-edge timers: the
// queue pumps UPLOAD_CONCURRENCY entries in parallel, so each entry owns its
// own timer and last-notified baseline. A single shared pair would drop a
// sibling's tick while one timer is pending, wrongly suppress a sibling whose
// fraction matched another entry's last-notified value, and let a
// start-of-upload reset leak across in-flight entries. A pending timer keeps
// absorbing that entry's burst (at most one notify per entry per
// PROGRESS_NOTIFY_INTERVAL_MS), and fires only when THAT entry's value
// changed since ITS own last notify.
interface ProgressCoalescer {
  timer: ReturnType<typeof setTimeout> | null;
  lastNotifiedProgress: number;
}
const progressCoalescers = new Map<string, ProgressCoalescer>();

function coalescerFor(entryId: string): ProgressCoalescer {
  let state = progressCoalescers.get(entryId);
  if (!state) {
    state = { timer: null, lastNotifiedProgress: 0 };
    progressCoalescers.set(entryId, state);
  }
  return state;
}

// Records must never outlive their entry or the map would grow with every
// upload. Entry ids are never reused, so any record whose id is no longer a
// queued/uploading entry in the live list is dead — cancel its pending timer
// (if any) and drop it. Cheap sweep: records only exist for entries that have
// reported progress, and every progress path funnels through here-adjacent
// entry points below.
function pruneDeadCoalescers(): void {
  if (progressCoalescers.size === 0) return;
  const activeIds = new Set(
    entriesRef()
      .filter((e) => e.status === "queued" || e.status === "uploading")
      .map((e) => e.id),
  );
  for (const [id, state] of progressCoalescers) {
    if (activeIds.has(id)) continue;
    if (state.timer !== null) clearTimeout(state.timer);
    progressCoalescers.delete(id);
  }
}

// Read-only view of the queue's live entries, injected by queue.ts at module
// load (bindEntries). The entries array itself stays owned and mutated by
// queue.ts — this module only ever READS through the getter, which breaks what
// would otherwise be a queue -> events -> queue import cycle.
let entriesRef: () => readonly InternalEntry[] = () => [];
export function bindEntries(source: () => readonly InternalEntry[]): void {
  entriesRef = source;
}

// Active upload coverage — single source of truth shared with queue.ts's
// getUploadingIds: the ids that count as "uploading" are the entry id, the
// Drive id once known, and the parent folder id (never 'root') of every
// queued/uploading entry. queue.ts imports collectActiveCoverage to build its
// flat set; getUploadState resolves a single id against the same rule.
function isActiveEntry(entry: InternalEntry): boolean {
  return entry.status === "queued" || entry.status === "uploading";
}

export function collectActiveCoverage(): {
  ids: Set<string>;
  driveIds: Set<string>;
  parentIds: Set<string>;
} {
  const ids = new Set<string>();
  const driveIds = new Set<string>();
  const parentIds = new Set<string>();
  for (const entry of entriesRef()) {
    if (!isActiveEntry(entry)) continue;
    ids.add(entry.id);
    if (entry.driveId) driveIds.add(entry.driveId);
    // The parent folder must stay locked (spinner, no dim) while a child uploads.
    if (entry.parentId !== ROOT_FOLDER_ID) parentIds.add(entry.parentId);
  }
  return { ids, driveIds, parentIds };
}

/**
 * Resolve a single item id to its upload presentation state ('uploading' wins
 * when an id matches both the entry and a child upload under it). Callers use
 * this to decide a row's dim/spinner/green-check rendering.
 * @param id The entry id, Drive id, or parent folder id to look up.
 * @returns The state that row should render ('none' when not uploading).
 */
export function getUploadState(id: string): UploadState {
  const { ids, driveIds, parentIds } = collectActiveCoverage();
  if (ids.has(id) || driveIds.has(id)) return "uploading";
  if (parentIds.has(id)) return "parent-uploading";
  // A folder that just finished must still show its child-upload spinner while
  // a child uploads under it — parent-uploading beats the transient check.
  if (recentlyDoneIds.has(id)) return "uploaded";
  return "none";
}

// Mark an id as just-finished so the row shows the green check; auto-clears
// after UPLOADED_TINT_MS. No immediate notify: the caller (markComplete) runs
// this right before finishEntry, whose own notify picks up the new state.
export function markRecentlyDone(id: string): void {
  recentlyDoneIds.add(id);
  window.setTimeout(() => {
    recentlyDoneIds.delete(id);
    notify();
  }, UPLOADED_TINT_MS);
}

/**
 * Hide the green check early (e.g. the user clicked the row to play it) and
 * return the row to its idle MoreMenu state.
 * @param id The entry or Drive id whose tint should clear.
 */
export function dismissUploaded(id: string): void {
  if (recentlyDoneIds.delete(id)) notify();
}

/**
 * Clear EVERY "just uploaded" check at once (e.g. the user left the My Drive
 * tab and MainContent unmounted) — the tint is presentation-only, so a fresh
 * visit must show no stale checks. No-op (and no notify) when already empty,
 * same silent pattern as dismissUploaded.
 */
export function clearUploadedTint(): void {
  if (recentlyDoneIds.size === 0) return;
  recentlyDoneIds.clear();
  notify();
}

/**
 * Subscribe to upload-state changes (status flips, progress ticks, cancels).
 * The callback must be resilient: a throwing subscriber is caught and
 * logged, never allowed to break the notify loop.
 * @param cb Called on every state change after the queue mutates.
 * @returns An unsubscribe function; call it on unmount to stop receiving
 * notifications (and to let the manager drop the reference).
 */
export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
/**
 * Snapshot of every upload entry (queued, uploading, and terminal). Terminal
 * entries are pruned right after they notify, so the snapshot is a point-in-
 * time view: subscribers must consume the 'done'/'error' state from the
 * notify that preceded the prune, not from a later getEntries call.
 * @returns A shallow copy of the internal entries with internal fields
 * (token, memo, drive id) stripped — safe for any consumer.
 */
export function getEntries(): UploadEntry[] {
  return entriesRef().map((e) => ({
    id: e.id,
    name: e.name,
    isFolder: e.isFolder,
    parentId: e.parentId,
    status: e.status,
    diskPath: e.diskPath,
    bytes: e.bytes,
    error: e.error,
    progress: e.progress,
  }));
}

// Fire subscribers; a throwing subscriber must not break the loop.
export function notify(): void {
  for (const cb of subscribers) {
    try {
      cb();
    } catch (err) {
      // fire-and-forget: logging must not throw in this sync path
      // (captureError never rejects — it swallows failures internally).
      void captureError({
        level: "warn",
        source: MODULE,
        message: `subscriber-failed: ${describeError(err)}`,
      });
    }
  }
}

// Coalesce per entry: a pending timer is left running (new bursts from the
// SAME entry merge into it — bursts from a sibling get their own timer). The
// callback re-checks the entry (still queued/uploading? progress changed
// since this entry's last notify?) because the entry may have gone terminal
// while its timer was pending.
export function scheduleProgressNotify(entry: InternalEntry): void {
  pruneDeadCoalescers();
  const state = coalescerFor(entry.id);
  if (state.timer !== null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    const active = entry.status === "queued" || entry.status === "uploading";
    if (!active || entry.progress === undefined) return;
    if (entry.progress === state.lastNotifiedProgress) return;
    state.lastNotifiedProgress = entry.progress;
    notify();
  }, PROGRESS_NOTIFY_INTERVAL_MS);
}

// Terminal transitions notify immediately themselves, so no pending progress
// timer may fire a stale notify afterwards. Every terminal transition calls
// this without an entry argument, so it clears ALL pending timers + records —
// the same global scope the pre-concurrency singleton version had. A sibling
// entry merely loses its current throttled window: its next chunk tick
// re-schedules within PROGRESS_NOTIFY_INTERVAL_MS.
export function clearProgressNotifyTimer(): void {
  for (const state of progressCoalescers.values()) {
    if (state.timer !== null) clearTimeout(state.timer);
  }
  progressCoalescers.clear();
}

// Kept for processEntry's start-of-upload call. With per-entry state keyed by
// never-reused ids, a starting entry has no record yet (baseline 0 by
// construction), so no shared baseline needs resetting anymore — the call now
// only sweeps records left behind by entries that already went terminal.
export function resetProgressNotify(): void {
  pruneDeadCoalescers();
}
