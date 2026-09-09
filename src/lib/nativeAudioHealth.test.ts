// @vitest-environment jsdom
// Unit tests for the health unit extracted from NativeAudioEngine — the
// idempotency/retry logic is exercised directly through injected deps, with
// no tauri imports involved (the engine owns the real IPC).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NativeBridgeHealth } from "./nativeAudioHealth";
import type { HealthDeps } from "./nativeAudioHealth";

const makeDeps = () =>
  ({
    initOnceCommand: vi.fn().mockResolvedValue(undefined),
    probeState: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn(),
    report: vi.fn(),
  }) satisfies HealthDeps;

// Drain pending microtasks deterministically (same harness as
// nativeAudioBridge.test.ts's resume health-check section — no timers).
const drainMicrotasks = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

const dispatchVisible = () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

// jsdom's document outlives individual tests — record every visibilitychange
// registration and remove exactly those after each test.
const addSpy = vi.spyOn(document, "addEventListener");
afterEach(() => {
  for (const [type, handler] of addSpy.mock.calls) {
    if (type === "visibilitychange") {
      document.removeEventListener(type, handler as EventListener);
    }
  }
  addSpy.mockClear();
});

describe("NativeBridgeHealth", () => {
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("initOnce invokes the init command exactly once across repeated calls (idempotent)", async () => {
    const deps = makeDeps();
    const health = new NativeBridgeHealth(deps);

    await health.initOnce();
    await health.initOnce();

    expect(deps.initOnceCommand).toHaveBeenCalledTimes(1);
  });

  it("resets the cached init when the init command fails so a later call retries", async () => {
    const deps = makeDeps();
    deps.initOnceCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const health = new NativeBridgeHealth(deps);

    await expect(health.initOnce()).rejects.toThrow("boom");
    await health.initOnce();

    expect(deps.initOnceCommand).toHaveBeenCalledTimes(2);
  });

  it("pullCurrentState skips an undefined snapshot and fans a real one through onState", async () => {
    const deps = makeDeps();
    const health = new NativeBridgeHealth(deps);

    await health.pullCurrentState();
    expect(deps.onState).not.toHaveBeenCalled();

    deps.probeState = vi.fn().mockResolvedValue({ status: "playing" });
    await health.pullCurrentState();
    expect(deps.onState).toHaveBeenCalledWith({ status: "playing" });
  });

  it("probe fail → re-init → re-pull; a second dead probe only logs, no loop", async () => {
    const deps = makeDeps();
    deps.probeState = vi.fn().mockRejectedValue(new Error("dead"));
    const health = new NativeBridgeHealth(deps);
    await health.initOnce();
    deps.initOnceCommand.mockClear();

    dispatchVisible();
    await drainMicrotasks();

    // Exactly one probe attempt + one re-pull after re-init: bounded, no
    // polling loop.
    expect(deps.probeState).toHaveBeenCalledTimes(2);
    expect(deps.initOnceCommand).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenCalledWith(
      "resume health-check failed, re-initializing",
      expect.any(Error),
    );
    expect(deps.report).toHaveBeenCalledWith(
      "resume re-init failed",
      expect.any(Error),
    );
  });
});
