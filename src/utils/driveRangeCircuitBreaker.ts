// ---- Drive throttle circuit breaker (Fix H).
// When Drive starts throttling an account (429s / timeouts under load), every
// retry and every cover POST keeps hammering it — the metadata pipeline's
// 30s timeout + retry (Fix B) actually SUSTAINED the auto-next loop. The
// breaker trips after DRIVE_FAILURE_THRESHOLD failures inside a sliding
// DRIVE_FAILURE_WINDOW_MS window, then fails fast for DRIVE_COOLDOWN_MS so the
// account can recover. State is module-level (shared app-wide, like
// rangeFetchSemaphore) because the throttle is per-account, not per-file.
// (Refactor: extracted verbatim from driveRangeTokenizer.ts; the log source
// stays "driveRangeTokenizer" so existing error-log entries and test
// assertions keep matching.)
import { captureError } from "./errorLog";

export const DRIVE_FAILURE_THRESHOLD = 3;
export const DRIVE_FAILURE_WINDOW_MS = 30_000;
export const DRIVE_COOLDOWN_MS = 60_000;
const TOKENIZER_MODULE = "driveRangeTokenizer";

const driveFailureTimes: number[] = [];
let driveCircuitOpenedAt: number | null = null;

function pruneDriveFailures(now: number): void {
  while (
    driveFailureTimes.length > 0 &&
    now - (driveFailureTimes[0] ?? 0) > DRIVE_FAILURE_WINDOW_MS
  ) {
    driveFailureTimes.shift();
  }
}

/** Records one failed range fetch (timeout / network / 5xx / 429). */
export function recordDriveFailure(): void {
  const now = Date.now();
  pruneDriveFailures(now);
  driveFailureTimes.push(now);
  if (
    driveCircuitOpenedAt === null &&
    driveFailureTimes.length >= DRIVE_FAILURE_THRESHOLD
  ) {
    driveCircuitOpenedAt = now;
    void captureError({
      level: "warn",
      source: TOKENIZER_MODULE,
      message: `drive-throttle-circuit-opened (failures=${String(driveFailureTimes.length)} in ${String(DRIVE_FAILURE_WINDOW_MS)}ms)`,
    });
  }
}

/**
 * Records one successful range fetch. A success only prunes stale failures
 * — it never closes an open circuit early (a success cannot even happen
 * while the circuit is open, because no fetch runs during the cooldown).
 */
export function recordDriveSuccess(): void {
  pruneDriveFailures(Date.now());
}

/**
 * True when the breaker is open: the circuit stays open for the full
 * DRIVE_COOLDOWN_MS after it tripped, then closes and resets the failure
 * history so the account gets a fresh chance.
 */
export function isDriveCircuitOpen(): boolean {
  const now = Date.now();
  if (driveCircuitOpenedAt !== null) {
    if (now - driveCircuitOpenedAt < DRIVE_COOLDOWN_MS) return true;
    driveCircuitOpenedAt = null;
    driveFailureTimes.length = 0;
  } else {
    pruneDriveFailures(now);
  }
  return false;
}

/** Test-only: drops all breaker state (module-level, shared across tests). */
export function resetDriveCircuitBreakerForTests(): void {
  driveFailureTimes.length = 0;
  driveCircuitOpenedAt = null;
}
