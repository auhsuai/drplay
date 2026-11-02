// ---- Drive throttle circuit breaker (Fix H / Phase A2).
//
// Contract (pinned by the breaker + fetcher tests):
//  1. ONE failure per LOGICAL operation. The fetcher retries internally
//     (timeout x2, 429/5xx x3); those attempts are an implementation detail
//     and must NOT each consume a breaker slot. Callers therefore record the
//     FINAL outcome exactly once, via `recordDriveFailure(signal)`.
//  2. ONLY genuine throttle signals (`"throttle"`: 429 / confirmed Drive
//     rate-limit 403) may OPEN the circuit. Isolated timeouts/network errors
//     are local problems — three slow files must never black out the app.
//  3. A success RESETS the throttle window: an account still serving requests
//     is not throttled, no matter how many failures preceded it.
//  4. Recovery is a SINGLE-PROBE half-open state: after DRIVE_COOLDOWN_MS one
//     operation is admitted; everyone else keeps failing fast until that probe
//     reports its outcome.
//  5. Rejections never mutate state → no self-reinforcing reopen.
//
// State is module-level (shared app-wide, like the range-fetch semaphore)
// because Drive throttles per account, not per file.
// (The log source stays "driveRangeTokenizer" so existing error-log entries
// and test assertions keep matching.)
import { captureError } from "./errorLog";

/** Logical throttle failures inside the window needed to open the circuit. */
export const DRIVE_FAILURE_THRESHOLD = 3;
/** Sliding window for those logical failures. */
export const DRIVE_FAILURE_WINDOW_MS = 30_000;
/** How long the circuit stays open before a single probe is admitted. */
export const DRIVE_COOLDOWN_MS = 60_000;
const TOKENIZER_MODULE = "driveRangeTokenizer";

/**
 * Why one logical range operation failed:
 * - "throttle": 429 / confirmed Drive rate-limit 403 — the account is being
 *   throttled. The ONLY signal that counts toward opening the circuit.
 * - "transient": timeout / network / 5xx / body-stream failure — a local or
 *   server-side problem. Tracked for diagnostics, never a blackout trigger.
 */
export type DriveFailureSignal = "throttle" | "transient";

export type DriveCircuitState = "closed" | "open" | "half_open";

/** Admission result for one logical operation. */
export type DriveCircuitAdmission =
  | "closed" // normal traffic
  | "probe" // this operation is the single half-open probe
  | "rejected"; // circuit open, or another probe is in flight

type MutableState = {
  state: DriveCircuitState;
  /** Wall-clock time the circuit opened (null unless state === "open"). */
  openedAt: number | null;
  /** Throttle-only failure timestamps inside the window. */
  throttleFailureTimes: number[];
  /** True while the single half-open probe has been handed out. */
  probeInFlight: boolean;
};

const state: MutableState = {
  state: "closed",
  openedAt: null,
  throttleFailureTimes: [],
  probeInFlight: false,
};

function pruneThrottleFailures(now: number): void {
  while (
    state.throttleFailureTimes.length > 0 &&
    now - (state.throttleFailureTimes[0] ?? 0) > DRIVE_FAILURE_WINDOW_MS
  ) {
    state.throttleFailureTimes.shift();
  }
}

function openCircuit(now: number, reason: string): void {
  state.state = "open";
  state.openedAt = now;
  state.probeInFlight = false;
  void captureError({
    level: "warn",
    source: TOKENIZER_MODULE,
    message: `drive-throttle-circuit-opened (${reason}, failures=${String(state.throttleFailureTimes.length)} in ${String(DRIVE_FAILURE_WINDOW_MS)}ms, cooldown=${String(DRIVE_COOLDOWN_MS)}ms)`,
  });
}

/**
 * Admission gate for ONE logical range operation. Call exactly once per
 * logical operation, BEFORE the retry loop — never per internal attempt.
 */
export function admitDriveCircuitOperation(): DriveCircuitAdmission {
  const now = Date.now();
  if (state.state === "closed") {
    pruneThrottleFailures(now);
    return "closed";
  }
  if (state.state === "open") {
    if (state.openedAt !== null && now - state.openedAt < DRIVE_COOLDOWN_MS) {
      // Rejection: NO state mutation (never extend/re-trip on a rejection).
      return "rejected";
    }
    // Cooldown elapsed — hand the single probe to this operation only.
    state.state = "half_open";
    state.probeInFlight = true;
    return "probe";
  }
  // half_open: only the probe owner was admitted; everyone else fails fast.
  // A probe that was ALREADY released (aborted before dispatch) can be
  // claimed again, so a cancelled probe never wastes the whole cooldown.
  if (state.probeInFlight) return "rejected";
  state.probeInFlight = true;
  return "probe";
}

/**
 * Observation-only accessor: never mutates state and never grants a probe.
 * True while traffic is being rejected (open, or half-open with the probe
 * still outstanding). Used by tests and diagnostics.
 */
export function isDriveCircuitOpen(): boolean {
  if (state.state === "closed") return false;
  if (state.state === "half_open") return true;
  const now = Date.now();
  if (state.openedAt !== null && now - state.openedAt < DRIVE_COOLDOWN_MS) {
    return true;
  }
  // Cooldown elapsed: the next operation may probe — traffic is no longer
  // being rejected outright.
  return false;
}

/** Observation-only accessor (tests + diagnostics). */
export function getDriveCircuitState(): DriveCircuitState {
  return state.state;
}

/** Throttle failures currently inside the window (diagnostics/tests). */
export function getDriveThrottleFailureCount(): number {
  pruneThrottleFailures(Date.now());
  return state.throttleFailureTimes.length;
}

/**
 * Records the FINAL outcome of one logical range operation. Exactly one of
 * `recordDriveFailure` / `recordDriveSuccess` must be called per operation.
 * Only "throttle" failures count toward opening the circuit.
 */
export function recordDriveFailure(signal: DriveFailureSignal): void {
  const now = Date.now();
  if (state.state === "half_open") {
    state.probeInFlight = false;
    if (signal === "throttle") {
      // The probe confirmed the account is still throttled: re-open.
      state.throttleFailureTimes.length = 0;
      state.throttleFailureTimes.push(now);
      openCircuit(now, "probe-failed");
      return;
    }
    // A non-throttle probe failure is no evidence of throttling: close and
    // let traffic flow (one slow file is not a blackout).
    state.state = "closed";
    state.openedAt = null;
    state.throttleFailureTimes.length = 0;
    return;
  }
  if (state.state === "open") {
    // Rejections never reach here; a late failure must not EXTEND the open
    // window (that was the self-reinforcing reopen bug).
    state.probeInFlight = false;
    return;
  }
  if (signal !== "throttle") return; // transient: can never open the circuit
  pruneThrottleFailures(now);
  state.throttleFailureTimes.push(now);
  if (state.throttleFailureTimes.length >= DRIVE_FAILURE_THRESHOLD) {
    openCircuit(now, "threshold-reached");
  }
}

/**
 * Records a successful range fetch. A success RESETS the throttle window and
 * closes a half-open circuit: a Drive that still answers is not throttled.
 */
export function recordDriveSuccess(): void {
  state.throttleFailureTimes.length = 0;
  state.state = "closed";
  state.openedAt = null;
  state.probeInFlight = false;
}

/**
 * Releases a half-open probe WITHOUT an outcome (caller aborted before any
 * request went out). Keeps the circuit half-open so the next operation can
 * claim the probe instead of waiting a whole cooldown.
 */
export function releaseDriveCircuitProbe(): void {
  if (state.state === "half_open") state.probeInFlight = false;
}

/** Test-only: drops all breaker state (module-level, shared across tests). */
export function resetDriveCircuitBreakerForTests(): void {
  state.throttleFailureTimes.length = 0;
  state.state = "closed";
  state.openedAt = null;
  state.probeInFlight = false;
}
