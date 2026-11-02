import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRIVE_COOLDOWN_MS,
  DRIVE_FAILURE_THRESHOLD,
  DRIVE_FAILURE_WINDOW_MS,
  admitDriveCircuitOperation,
  getDriveCircuitState,
  getDriveThrottleFailureCount,
  isDriveCircuitOpen,
  recordDriveFailure,
  recordDriveSuccess,
  releaseDriveCircuitProbe,
  resetDriveCircuitBreakerForTests,
  type DriveCircuitAdmission,
} from "./driveRangeCircuitBreaker";
import * as errorLogModule from "./errorLog";

// Deterministic unit coverage for the Phase A2 breaker contract (dossier §7
// "Breaker accounting 1-10"): logical-op accounting, throttle-only opening,
// success reset, half-open single probe, rejection immutability.

beforeEach(() => {
  vi.useFakeTimers();
  resetDriveCircuitBreakerForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetDriveCircuitBreakerForTests();
});

function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
}

function admit(): DriveCircuitAdmission {
  return admitDriveCircuitOperation();
}

describe("driveRangeCircuitBreaker — Phase A2 contract", () => {
  it("1. opens only at the throttle threshold (one logical failure each)", () => {
    expect(DRIVE_FAILURE_THRESHOLD).toBe(3);
    expect(admit()).toBe("closed");
    recordDriveFailure("throttle");
    recordDriveFailure("throttle");
    expect(getDriveCircuitState()).toBe("closed");
    recordDriveFailure("throttle");
    expect(getDriveCircuitState()).toBe("open");
    expect(isDriveCircuitOpen()).toBe(true);
  });

  it("2. a single logical timeout can NEVER lock the pipeline (transient ignored)", () => {
    for (let i = 0; i < 10; i += 1) {
      recordDriveFailure("transient");
    }
    expect(getDriveCircuitState()).toBe("closed");
    expect(getDriveThrottleFailureCount()).toBe(0);
    expect(admit()).toBe("closed");
  });

  it("3. mixed transient + below-threshold throttle stays closed", () => {
    recordDriveFailure("transient");
    recordDriveFailure("throttle");
    recordDriveFailure("transient");
    expect(getDriveCircuitState()).toBe("closed");
    expect(getDriveThrottleFailureCount()).toBe(1);
  });

  it("4. one file's timeout does not block unrelated files (transient never opens)", () => {
    // Simulate 50 different files each timing out once.
    for (let i = 0; i < 50; i += 1) {
      expect(admit()).toBe("closed");
      recordDriveFailure("transient");
    }
    expect(isDriveCircuitOpen()).toBe(false);
  });

  it("5. a success resets the throttle window", () => {
    recordDriveFailure("throttle");
    recordDriveFailure("throttle");
    expect(getDriveThrottleFailureCount()).toBe(2);
    recordDriveSuccess();
    expect(getDriveThrottleFailureCount()).toBe(0);
    recordDriveFailure("throttle");
    recordDriveFailure("throttle");
    expect(getDriveCircuitState()).toBe("closed");
  });

  it("6. throttle failures age out of the sliding window", () => {
    recordDriveFailure("throttle");
    recordDriveFailure("throttle");
    advance(DRIVE_FAILURE_WINDOW_MS + 1);
    recordDriveFailure("throttle");
    expect(getDriveCircuitState()).toBe("closed");
    expect(getDriveThrottleFailureCount()).toBe(1);
  });

  it("7. half-open hands exactly one probe out after the cooldown", () => {
    for (let i = 0; i < DRIVE_FAILURE_THRESHOLD; i += 1) {
      recordDriveFailure("throttle");
    }
    expect(admit()).toBe("rejected");
    advance(DRIVE_COOLDOWN_MS + 1);
    expect(admit()).toBe("probe");
    // While the probe is outstanding, everyone else is rejected.
    expect(admit()).toBe("rejected");
    expect(admit()).toBe("rejected");
  });

  it("8. a successful probe closes the circuit and traffic resumes", () => {
    for (let i = 0; i < DRIVE_FAILURE_THRESHOLD; i += 1) {
      recordDriveFailure("throttle");
    }
    advance(DRIVE_COOLDOWN_MS + 1);
    expect(admit()).toBe("probe");
    recordDriveSuccess();
    expect(getDriveCircuitState()).toBe("closed");
    expect(isDriveCircuitOpen()).toBe(false);
    expect(admit()).toBe("closed");
  });

  it("9. a throttled probe failure re-opens for another full cooldown", () => {
    for (let i = 0; i < DRIVE_FAILURE_THRESHOLD; i += 1) {
      recordDriveFailure("throttle");
    }
    advance(DRIVE_COOLDOWN_MS + 1);
    expect(admit()).toBe("probe");
    const openedAt = Date.now();
    recordDriveFailure("throttle");
    expect(getDriveCircuitState()).toBe("open");
    expect(admit()).toBe("rejected");
    // Full cooldown from the probe failure, not the original open time.
    advance(DRIVE_COOLDOWN_MS - 1);
    expect(isDriveCircuitOpen()).toBe(true);
    advance(2);
    expect(Date.now()).toBeGreaterThan(openedAt + DRIVE_COOLDOWN_MS);
    expect(admit()).toBe("probe");
  });

  it("10. a transient probe failure CLOSES instead of blacking the app out", () => {
    for (let i = 0; i < DRIVE_FAILURE_THRESHOLD; i += 1) {
      recordDriveFailure("throttle");
    }
    advance(DRIVE_COOLDOWN_MS + 1);
    expect(admit()).toBe("probe");
    recordDriveFailure("transient");
    expect(getDriveCircuitState()).toBe("closed");
    expect(admit()).toBe("closed");
  });

  it("11. a breaker rejection never mutates state (no self-reinforcing reopen)", () => {
    for (let i = 0; i < DRIVE_FAILURE_THRESHOLD; i += 1) {
      recordDriveFailure("throttle");
    }
    const openedAt = Date.now();
    advance(DRIVE_COOLDOWN_MS / 2);
    for (let i = 0; i < 20; i += 1) {
      expect(admit()).toBe("rejected");
      expect(isDriveCircuitOpen()).toBe(true);
    }
    // The deadline is still the ORIGINAL open time.
    advance(DRIVE_COOLDOWN_MS / 2 + 1);
    expect(Date.now()).toBeGreaterThan(openedAt + DRIVE_COOLDOWN_MS);
    expect(admit()).toBe("probe");
  });

  it("12. isDriveCircuitOpen never grants a probe (observation-only)", () => {
    for (let i = 0; i < DRIVE_FAILURE_THRESHOLD; i += 1) {
      recordDriveFailure("throttle");
    }
    advance(DRIVE_COOLDOWN_MS + 1);
    // Observation does not consume the probe...
    expect(isDriveCircuitOpen()).toBe(false);
    // ...and the probe is still available afterwards.
    expect(admit()).toBe("probe");
    expect(admit()).toBe("rejected");
  });

  it("13. a released probe can be claimed again (cancelled before dispatch)", () => {
    for (let i = 0; i < DRIVE_FAILURE_THRESHOLD; i += 1) {
      recordDriveFailure("throttle");
    }
    advance(DRIVE_COOLDOWN_MS + 1);
    expect(admit()).toBe("probe");
    expect(admit()).toBe("rejected");
    releaseDriveCircuitProbe();
    expect(admit()).toBe("probe");
  });

  it("14. opening logs exactly once with the failure count and cooldown", () => {
    const spy = vi.spyOn(errorLogModule, "captureError").mockResolvedValue();
    for (let i = 0; i < DRIVE_FAILURE_THRESHOLD; i += 1) {
      recordDriveFailure("throttle");
    }
    const openedLogs = spy.mock.calls.filter(([args]) =>
      args.message.includes("drive-throttle-circuit-opened"),
    );
    expect(openedLogs).toHaveLength(1);
    expect(openedLogs[0]?.[0].message).toContain(
      `cooldown=${String(DRIVE_COOLDOWN_MS)}ms`,
    );
    expect(spy.mock.calls.some(([a]) => a.level === "error")).toBe(false);
  });
});
