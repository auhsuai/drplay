/**
 * Playback intent controller (audit RC-1, slice R3.1a).
 *
 * Single ownership point for "which playback action is in flight". Before this
 * module only the play attempt (AbortController + isCurrentAttempt in
 * usePlayerTrackPlayback) and the resume attempt (resumeSignalRef in usePlayer)
 * had an owner; pause/next/prev/stop had no identity, and a system lane
 * (auto-advance) could abort a user intent mid-flight (audit B5-4/SC3).
 *
 * Semantics — locked by playbackIntent.test.ts:
 * - `beginIntent(kind)` returns a handle with a monotonic `id` and its own
 *   AbortSignal. A granted intent SUPERSEDES the previous one: the previous
 *   signal is aborted (stale token/metadata continuations drop) and the old
 *   handle's `isCurrent()` turns false — `commitIfCurrent(oldId, ...)` is a
 *   silent no-op (counted in staleDrops).
 * - USER kinds (play/pause/resume/next/prev/stop) always supersede.
 * - SYSTEM kinds (auto-advance/restore/retry/recovery) are REFUSED while a
 *   user intent is in flight: a system continuation must never invalidate the
 *   track the user chose (contract (a), audit B5-4). A refused handle is never
 *   current and its signal is never aborted.
 * - `end()` retires an intent WITHOUT aborting its signal: deferred
 *   display-only continuations (metadata fold, SW prefetch) still hang off
 *   that signal after the intent's commit. Superseding a later intent aborts
 *   it (same abort-previous contract the old createAbortSignal had).
 * - `bumpSessionEpoch()` (logout/delete/teardown) invalidates EVERY in-flight
 *   intent at once (epoch check + abort), closing SC1/SC3-style stale commits.
 * - `abortCurrentIntent()` aborts the current signal WITHOUT swapping the
 *   handle, so owner-checked cleanup of the aborted attempt still runs
 *   (H1/UTP-5 pattern).
 * - Observability is deliberately minimal (counters + query helpers) — no
 *   event emitter: this module is a coordination primitive, not a bus.
 */

export type IntentKind =
  | "play"
  | "pause"
  | "resume"
  | "next"
  | "prev"
  | "stop"
  | "auto-advance"
  | "restore"
  | "retry"
  | "recovery";

export type IntentPriority = "user" | "system";

const USER_KINDS: ReadonlySet<IntentKind> = new Set([
  "play",
  "pause",
  "resume",
  "next",
  "prev",
  "stop",
]);

export function intentPriority(kind: IntentKind): IntentPriority {
  return USER_KINDS.has(kind) ? "user" : "system";
}

export interface IntentHandle {
  readonly id: number;
  readonly kind: IntentKind;
  readonly priority: IntentPriority;
  /**
   * Signal owned by this intent. Aborted when the intent is superseded, when
   * `abortCurrentIntent()` targets it, or when the session epoch bumps. Never
   * aborted by `end()`.
   */
  readonly abortSignal: AbortSignal;
  /** True while this intent is the active one and its session epoch is alive. */
  isCurrent(): boolean;
  /**
   * Retire this intent (idempotent). Does NOT abort the signal — deferred
   * display-only work still needs it.
   */
  end(): void;
  /**
   * Abort this handle's signal whether or not the intent is still current —
   * unmount cleanup of the owner must still drop the deferred continuations
   * hanging off an already-ended intent.
   */
  abort(): void;
}

interface IntentRecord {
  id: number;
  kind: IntentKind;
  priority: IntentPriority;
  epoch: number;
  controller: AbortController;
  granted: boolean;
}

let nextIntentId = 1;
let sessionEpoch = 0;
let current: IntentRecord | null = null;
// Most recently created intent's controller, kept after end() so a later
// intent still drops that intent's deferred continuations (the abort-previous
// behaviour of the old createAbortSignal swap).
let lastController: AbortController | null = null;

const counters = {
  begun: 0,
  superseded: 0,
  refused: 0,
  staleDrops: 0,
  epochBumps: 0,
};

function makeHandle(record: IntentRecord): IntentHandle {
  return {
    id: record.id,
    kind: record.kind,
    priority: record.priority,
    abortSignal: record.controller.signal,
    isCurrent: () => record.granted && isCurrent(record.id),
    end: () => {
      if (current === record) current = null;
    },
    abort: () => {
      record.controller.abort();
    },
  };
}

export function beginIntent(kind: IntentKind): IntentHandle {
  const priority = intentPriority(kind);

  // System lanes must never invalidate a user intent (contract (a)): refuse
  // instead of superseding, so the caller can simply bail out.
  if (priority === "system" && hasActiveUserIntent()) {
    counters.refused += 1;
    return makeHandle({
      id: nextIntentId++,
      kind,
      priority,
      epoch: sessionEpoch,
      controller: new AbortController(),
      granted: false,
    });
  }

  if (current !== null) counters.superseded += 1;
  current?.controller.abort();
  lastController?.abort();

  const record: IntentRecord = {
    id: nextIntentId++,
    kind,
    priority,
    epoch: sessionEpoch,
    controller: new AbortController(),
    granted: true,
  };
  current = record;
  lastController = record.controller;
  counters.begun += 1;
  return makeHandle(record);
}

/** True while `id` is the active intent of the live session. */
export function isCurrent(id: number): boolean {
  return (
    current !== null && current.id === id && current.epoch === sessionEpoch
  );
}

/** True while a user intent (play/pause/resume/next/prev/stop) is in flight. */
export function hasActiveUserIntent(): boolean {
  return current !== null && current.priority === "user";
}

/**
 * Run `commit` only if `id` is still current. Returns whether it ran — a
 * stale continuation must not touch the store/engine.
 */
export function commitIfCurrent(id: number, commit: () => void): boolean {
  if (!isCurrent(id)) {
    counters.staleDrops += 1;
    return false;
  }
  commit();
  return true;
}

/**
 * Abort the current intent's signal while keeping the handle current — the
 * aborted attempt's owner-checked cleanup (spinner release) must still run.
 */
export function abortCurrentIntent(): void {
  current?.controller.abort();
}

/** Signal of the active intent (null when none) — owner-check helper. */
export function getCurrentIntentSignal(): AbortSignal | null {
  return current?.controller.signal ?? null;
}

/**
 * Invalidate and abort every in-flight intent: logout/teardown/delete-file.
 * The next session starts clean (new intents capture the new epoch).
 */
export function bumpSessionEpoch(): void {
  counters.epochBumps += 1;
  sessionEpoch += 1;
  const active = current;
  current = null;
  active?.controller.abort();
  if (lastController !== active?.controller) lastController?.abort();
}

/** Minimal observability (audit §12.8): copy of the lifetime counters. */
export function getIntentCounters(): {
  begun: number;
  superseded: number;
  refused: number;
  staleDrops: number;
  epochBumps: number;
} {
  return { ...counters };
}

/** Test-only reset of the process-global state (pattern: __resetPlaybackCommitSourceForTests). */
export function __resetPlaybackIntentForTests(): void {
  nextIntentId = 1;
  sessionEpoch = 0;
  current = null;
  lastController = null;
  counters.begun = 0;
  counters.superseded = 0;
  counters.refused = 0;
  counters.staleDrops = 0;
  counters.epochBumps = 0;
}
