import { del as kvDel, get as kvGet, set as kvSet } from "../db/kv";
import { captureError } from "./errorLog";
import { DEFAULT_USER_EMAIL, getCurrentUserEmail } from "./storageKeys";
import type { PlayMode, Track } from "../types";

// RC-7 persistence boundary: the three playback lanes (session localStorage /
// queue kv / playMode kv) have exactly ONE owner. Every other module goes
// through this API — no direct localStorage/kv access to these keys.
//
// Keys are account scoped: `${base}::${email}` for a real logged-in account,
// the bare base key for the pre-login "default" sentinel (the historical
// global key, so logged-out behavior is unchanged). A scoped miss falls back
// to the legacy unscoped key ONE time — that is the upgrade path: data written
// before this module existed still restores, and the next save rewrites it
// scoped. clearPlayerPersistence wipes both scopes.
//
// Payloads carry an additive version field:
// - v2 session:  { v: 2, track, time, duration }  (v1: same object, no `v`)
// - v2 queue:    { v: 2, tracks: Track[] }        (v1: bare Track[])
// - v2 playMode: { v: 2, mode: PlayMode }         (v1: bare PlayMode string)
// A payload with an unknown version is logged and skipped (never misread as
// current-shape data), then the read chain moves to the next fallback key.

export const PLAYER_PERSISTENCE_KEYS = {
  session: "drplay_last_session",
  queue: "drplay_queue",
  playMode: "drplay_playmode",
} as const;

const PAYLOAD_VERSION = 2;
const MODULE = "playerPersistence";

const PLAY_MODES: readonly PlayMode[] = [
  "normal",
  "shuffle",
  "repeat-all",
  "repeat-one",
];

export interface StoredPlayerSession {
  track?: Track | undefined;
  time?: number | undefined;
  duration?: number | undefined;
}

type Decoded<T> = { ok: true; value: T } | { ok: false; reason: string };

// The last real account that resolved a scoped key this session. Logout
// removes USER_EMAIL_KEY *before* clearSessionState runs, so without this the
// account's scoped keys would resolve unscoped at clear time and survive.
let lastScopedEmail: string | null = null;

function resolveAccountEmail(): string | null {
  const email = getCurrentUserEmail();
  if (!email || email === DEFAULT_USER_EMAIL) return null;
  return email;
}

function scopedKey(base: string): string {
  const email = resolveAccountEmail();
  if (!email) return base;
  lastScopedEmail = email;
  return `${base}::${email}`;
}

function scopedThenLegacy(base: string): string[] {
  const scoped = scopedKey(base);
  // Pre-login the scoped key IS the legacy key — never read one slot twice.
  return scoped === base ? [base] : [scoped, base];
}

function logCorrupt(message: string): void {
  void captureError({ level: "warn", source: MODULE, message });
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isPlayMode(value: unknown): value is PlayMode {
  return (
    typeof value === "string" &&
    (PLAY_MODES as readonly string[]).includes(value)
  );
}

// Safe for logs: String() on an object would stringify to "[object Object]".
function describeVersion(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return "non-primitive";
}

function isValidQueueEntry(entry: unknown): entry is Track {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { id?: unknown }).id === "string"
  );
}

function decodeSession(raw: unknown): Decoded<StoredPlayerSession> {
  if (!isRecord(raw)) return { ok: false, reason: "invalid-shape" };
  if (raw.v !== undefined && raw.v !== PAYLOAD_VERSION) {
    return {
      ok: false,
      reason: `unsupported-version: ${describeVersion(raw.v)}`,
    };
  }
  // v1 and v2 share the flat shape; `track` presence is the caller's guard.
  // Field types stay the legacy cast contract — no deeper validation than the
  // pre-module code performed.
  return {
    ok: true,
    value: {
      track: raw.track as Track | undefined,
      time: raw.time as number | undefined,
      duration: raw.duration as number | undefined,
    },
  };
}

function decodeQueue(raw: unknown): Decoded<Track[]> {
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw; // v1
  } else if (isRecord(raw)) {
    if (raw.v !== PAYLOAD_VERSION) {
      return {
        ok: false,
        reason: `unsupported-version: ${describeVersion(raw.v)}`,
      };
    }
    if (!Array.isArray(raw.tracks)) {
      return { ok: false, reason: "invalid-shape" };
    }
    list = raw.tracks; // v2
  } else {
    return { ok: false, reason: "invalid-shape" };
  }
  const valid = list.filter(isValidQueueEntry);
  if (valid.length !== list.length) {
    logCorrupt(
      `session-queue-dropped-invalid: ${String(list.length - valid.length)}`,
    );
  }
  return { ok: true, value: valid };
}

function decodePlayMode(raw: unknown): Decoded<PlayMode> {
  const candidate = isRecord(raw) ? raw.mode : raw;
  if (isRecord(raw) && raw.v !== PAYLOAD_VERSION) {
    return {
      ok: false,
      reason: `unsupported-version: ${describeVersion(raw.v)}`,
    };
  }
  if (isPlayMode(candidate)) return { ok: true, value: candidate };
  return { ok: false, reason: "invalid-shape" };
}

/**
 * Restore read for the session lane. Precedence: scoped localStorage ->
 * scoped kv -> legacy localStorage -> legacy kv. A corrupt/unreadable entry is
 * logged and skipped; storage access errors (localStorage SecurityError,
 * kv failure) propagate to the caller's own error handling.
 */
export async function readSession(): Promise<StoredPlayerSession | undefined> {
  const scoped = scopedKey(PLAYER_PERSISTENCE_KEYS.session);
  const legacy = PLAYER_PERSISTENCE_KEYS.session;
  const steps: Array<{ storage: "localStorage" | "kv"; key: string }> = [
    { storage: "localStorage", key: scoped },
    { storage: "kv", key: scoped },
  ];
  if (scoped !== legacy) {
    steps.push(
      { storage: "localStorage", key: legacy },
      { storage: "kv", key: legacy },
    );
  }
  for (const step of steps) {
    let raw: unknown;
    if (step.storage === "localStorage") {
      const text = localStorage.getItem(step.key);
      if (text === null) continue;
      try {
        raw = JSON.parse(text);
      } catch (e: unknown) {
        logCorrupt(`session-corrupt: ${errorMessage(e)}`);
        continue;
      }
    } else {
      raw = await kvGet(step.key);
      if (raw === undefined || raw === null) continue;
    }
    const decoded = decodeSession(raw);
    if (!decoded.ok) {
      logCorrupt(`session-corrupt: ${decoded.reason}`);
      continue;
    }
    return decoded.value;
  }
  return undefined;
}

export async function readQueue(): Promise<Track[] | undefined> {
  for (const key of scopedThenLegacy(PLAYER_PERSISTENCE_KEYS.queue)) {
    const raw = await kvGet(key);
    if (raw === undefined || raw === null) continue;
    const decoded = decodeQueue(raw);
    if (!decoded.ok) {
      logCorrupt(`session-queue-corrupt: ${decoded.reason}`);
      continue;
    }
    return decoded.value;
  }
  return undefined;
}

export async function readPlayMode(): Promise<PlayMode | undefined> {
  for (const key of scopedThenLegacy(PLAYER_PERSISTENCE_KEYS.playMode)) {
    const raw = await kvGet(key);
    if (raw === undefined || raw === null) continue;
    const decoded = decodePlayMode(raw);
    if (!decoded.ok) {
      logCorrupt(`session-playmode-corrupt: ${decoded.reason}`);
      continue;
    }
    return decoded.value;
  }
  return undefined;
}

/** Throws on localStorage failure — the caller owns save-failure logging. */
export function writeSession(session: StoredPlayerSession): void {
  localStorage.setItem(
    scopedKey(PLAYER_PERSISTENCE_KEYS.session),
    JSON.stringify({ v: PAYLOAD_VERSION, ...session }),
  );
}

/** Rejects on kv failure — the caller owns save-failure logging. */
export async function writeQueue(queue: Track[]): Promise<void> {
  await kvSet(scopedKey(PLAYER_PERSISTENCE_KEYS.queue), {
    v: PAYLOAD_VERSION,
    tracks: queue,
  });
}

/** Rejects on kv failure — the caller owns save-failure logging. */
export async function writePlayMode(mode: PlayMode): Promise<void> {
  await kvSet(scopedKey(PLAYER_PERSISTENCE_KEYS.playMode), {
    v: PAYLOAD_VERSION,
    mode,
  });
}

/**
 * Logout wipe: every scoped variant of the current (and last used) account
 * plus the legacy unscoped keys, across both storage backends. Fire-and-forget
 * on the kv half; failures are logged, never thrown.
 */
export function clearPlayerPersistence(): void {
  const accounts = new Set<string>();
  if (lastScopedEmail) accounts.add(lastScopedEmail);
  const current = resolveAccountEmail();
  if (current) accounts.add(current);

  const localStorageKeys = new Set<string>([PLAYER_PERSISTENCE_KEYS.session]);
  const kvKeys = new Set<string>([
    PLAYER_PERSISTENCE_KEYS.session,
    PLAYER_PERSISTENCE_KEYS.queue,
    PLAYER_PERSISTENCE_KEYS.playMode,
  ]);
  for (const email of accounts) {
    localStorageKeys.add(`${PLAYER_PERSISTENCE_KEYS.session}::${email}`);
    kvKeys.add(`${PLAYER_PERSISTENCE_KEYS.session}::${email}`);
    kvKeys.add(`${PLAYER_PERSISTENCE_KEYS.queue}::${email}`);
    kvKeys.add(`${PLAYER_PERSISTENCE_KEYS.playMode}::${email}`);
  }

  try {
    for (const key of localStorageKeys) localStorage.removeItem(key);
  } catch (err: unknown) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: MODULE,
      kind: "localstorage-cleanup-failed",
      message: `localStorage cleanup failed: ${errorMessage(err)}`,
    });
  }

  void Promise.allSettled([...kvKeys].map((key) => kvDel(key))).then(
    (results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          // fire-and-forget: logging must not throw in this sync callback.
          void captureError({
            level: "warn",
            source: MODULE,
            kind: "logout-cleanup-failed",
            message: `logout-cleanup-failed: ${errorMessage(r.reason)}`,
          });
        }
      }
    },
  );
}
