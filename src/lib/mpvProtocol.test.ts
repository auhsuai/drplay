import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import { captureError } from "../utils/errorLog";
import {
  BUFFERING_TIMEOUT_MS,
  SPINNER_DELAY_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_STALE_MS,
  classifyEndFileError,
  dispatchMpvEvent,
  dispatchPropertyEvent,
  resetWarnThrottleForTest,
  STALL_LOAD_GRACE_MS,
  STALL_POLL_INTERVAL_MS,
  STALL_RECONCILE_MS,
  STALL_RECOVER_MS,
  STALL_RECOVERY_MAX_ATTEMPTS,
  type MpvEventCallbacks,
} from "./mpvProtocol";
import {
  BufferingTracker,
  StallReconciler,
  type StallTruth,
  TimePosWatchdog,
} from "./mpvPlaybackMachines";

function makeCb(): MpvEventCallbacks {
  return {
    onTimeUpdate: vi.fn(),
    onDuration: vi.fn(),
    onPauseChange: vi.fn(),
    onBuffering: vi.fn(),
    onCacheState: vi.fn(),
    onFileLoaded: vi.fn(),
    onEndFile: vi.fn(),
    onEngineClosed: vi.fn(),
    onMalformed: vi.fn(),
  };
}

describe("TimePosWatchdog (mpv issue #13695 backfill)", () => {
  let isPlaying: boolean;
  let getTimePos: Mock<() => Promise<unknown>>;
  let onTimeUpdate: Mock<(time: number) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
    isPlaying = true;
    getTimePos = vi.fn(() => Promise.resolve(42));
    onTimeUpdate = vi.fn<(time: number) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeWatchdog(): TimePosWatchdog {
    return new TimePosWatchdog(
      () => isPlaying,
      () => getTimePos(),
      (time) => {
        onTimeUpdate(time);
      },
    );
  }

  it("stale >1200ms while playing polls mpv_get_property and forwards via onTimeUpdate", async () => {
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    // 1000ms since start <= stale threshold: healthy, no poll yet.
    expect(getTimePos).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);
    expect(onTimeUpdate).toHaveBeenCalledTimes(1);
    expect(onTimeUpdate).toHaveBeenCalledWith(42);

    // Recovery refreshed the staleness clock: no double-poll next tick.
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);
  });

  it("regular timeupdate pushes keep it quiet (no poll)", async () => {
    const wd = makeWatchdog();
    wd.start();

    for (let i = 0; i < 10; i++) {
      wd.noteEmit();
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(getTimePos).not.toHaveBeenCalled();
    expect(onTimeUpdate).not.toHaveBeenCalled();
  });

  it("isPlaying=false never arms an interval (no poll, no timer)", async () => {
    isPlaying = false;
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(5000);

    expect(getTimePos).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isPlaying flipping false mid-run stops itself (self-heal, no leak)", async () => {
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    isPlaying = false; // pause event flipped the store mid-watch
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getTimePos).not.toHaveBeenCalled();
  });

  it("stop() cancels the interval (release path, no timer leak)", async () => {
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);

    wd.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getTimePos).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the handle with clearInterval (interval-type timer hygiene)", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const wd = makeWatchdog();
    wd.start();
    clearIntervalSpy.mockClear();

    wd.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("null poll result skips the round (no forward) and rate-limits the nil-drop warn", async () => {
    getTimePos.mockReturnValue(Promise.resolve(null));
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "mpvProtocol",
      }),
    );
    const message = vi.mocked(captureError).mock.calls[0]?.[0]?.message ?? "";
    expect(message).toContain("time-pos");
    expect(message).toContain("null");

    // Next rounds keep polling (stale never refreshed) but stay silent <30s.
    await vi.advanceTimersByTimeAsync(3 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(4);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);

    // Past the 30s window the next nil round logs again.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(2);
  });

  it("poll rejection is a skipped round: warn with context, no throw, no forward", async () => {
    getTimePos.mockImplementation(() =>
      Promise.reject(new Error("mpv is not running (call mpv_spawn first)")),
    );
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(onTimeUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "mpvProtocol" }),
    );

    wd.stop();
  });

  it("a hung poll does not stack overlapping invocations (in-flight guard)", async () => {
    getTimePos.mockReturnValue(new Promise(() => {}));
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);

    wd.stop();
  });

  it("stop() during an in-flight poll drops the late result (generation guard, no forward)", async () => {
    let resolvePoll!: (value: unknown) => void;
    getTimePos.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
    );
    const wd = makeWatchdog();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1); // poll awaiting the IPC reply

    wd.stop(); // teardown while the poll is in flight
    resolvePoll(42);
    await vi.advanceTimersByTimeAsync(0);

    expect(onTimeUpdate).not.toHaveBeenCalled();
  });

  it("start() while already running does not stack a second interval", async () => {
    const wd = makeWatchdog();
    wd.start();
    wd.start();

    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(getTimePos).toHaveBeenCalledTimes(1);

    wd.stop();
  });
});

describe("StallReconciler (pinned-playhead self-heal)", () => {
  let active: boolean;
  let busy: boolean;
  let truth: StallTruth;
  let queryError: Error | null;
  let queryTruth: Mock<() => Promise<StallTruth>>;
  let onReconcileBuffering: Mock<(buffering: boolean) => void>;
  let onStallRecover: Mock<(pinnedTime: number, attempt: number) => void>;
  let onStallExhausted: Mock<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // Date.now() off the 0 sentinel
    resetWarnThrottleForTest();
    vi.mocked(captureError).mockClear();
    active = true;
    busy = false;
    truth = { timePos: 42, buffering: true, cacheEnd: 100 };
    queryError = null;
    queryTruth = vi.fn(() =>
      queryError === null ? Promise.resolve(truth) : Promise.reject(queryError),
    );
    onReconcileBuffering = vi.fn();
    onStallRecover = vi.fn();
    onStallExhausted = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeReconciler(): StallReconciler {
    return new StallReconciler({
      isActive: () => active,
      isBusy: () => busy,
      queryTruth: () => queryTruth(),
      onReconcileBuffering: (buffering) => {
        onReconcileBuffering(buffering);
      },
      onStallRecover: (pinnedTime, attempt) => {
        onStallRecover(pinnedTime, attempt);
      },
      onStallExhausted: () => {
        onStallExhausted();
      },
    });
  }

  it("pinned playhead: recover #1 at 75s, #2 at +75s, exhausted once at +75s, then silent", async () => {
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(STALL_RECOVER_MS);
    expect(onStallRecover).toHaveBeenCalledTimes(1);
    expect(onStallRecover).toHaveBeenLastCalledWith(42, 1);
    expect(onStallExhausted).not.toHaveBeenCalled();
    expect(onReconcileBuffering).not.toHaveBeenCalled(); // truth says buffering

    await vi.advanceTimersByTimeAsync(STALL_RECOVER_MS);
    expect(onStallRecover).toHaveBeenCalledTimes(2);
    expect(onStallRecover).toHaveBeenLastCalledWith(42, 2);
    expect(onStallExhausted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STALL_RECOVER_MS);
    expect(onStallExhausted).toHaveBeenCalledTimes(1);
    expect(onStallRecover).toHaveBeenCalledTimes(2);

    const rounds = queryTruth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * STALL_RECOVER_MS);
    expect(queryTruth).toHaveBeenCalledTimes(rounds); // poller stopped for good
    expect(onStallExhausted).toHaveBeenCalledTimes(1);
    expect(onStallRecover).toHaveBeenCalledTimes(2);
  });

  it("progressing time-pos: never recovers, even after 10 minutes of polling", async () => {
    let timePos = 42;
    queryTruth.mockImplementation(() => {
      timePos += 0.4; // every poll lands on a moved playhead
      return Promise.resolve({ timePos, buffering: false, cacheEnd: 100 });
    });
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(600_000);

    expect(onStallRecover).not.toHaveBeenCalled();
    expect(onStallExhausted).not.toHaveBeenCalled();
    expect(onReconcileBuffering).toHaveBeenCalled(); // spinner reconcile still runs
    sc.stop();
  });

  it("cacheEnd growing while time-pos is pinned: never recovers", async () => {
    let cacheEnd = 100;
    queryTruth.mockImplementation(() => {
      cacheEnd += 10; // download still progressing — not a dead stall
      return Promise.resolve({ timePos: 42, buffering: true, cacheEnd });
    });
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(600_000);

    expect(onStallRecover).not.toHaveBeenCalled();
    expect(onStallExhausted).not.toHaveBeenCalled();
    sc.stop();
  });

  it("load-wedged playhead (time-pos stuck at 0, cacheEnd growing): the load grace ends in a recovery — never a silent download", async () => {
    // The H1 bug shape: `loadfile replace` wedged mpv's playback chain. The
    // playhead never left zero while the demuxer kept downloading the stream.
    // The old rule counted that download as progress, so recovery never fired
    // and nothing was ever logged.
    let cacheEnd = 100;
    queryTruth.mockImplementation(() => {
      cacheEnd += 10;
      return Promise.resolve({ timePos: 0, buffering: false, cacheEnd });
    });
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(
      STALL_LOAD_GRACE_MS + STALL_POLL_INTERVAL_MS,
    );

    expect(onStallRecover).toHaveBeenCalledTimes(1);
    expect(onStallRecover).toHaveBeenLastCalledWith(0, 1);
    sc.stop();
  });

  it("a slow first load inside the grace is never reloaded; past the grace the normal bounded budget applies", async () => {
    let cacheEnd = 100;
    queryTruth.mockImplementation(() => {
      cacheEnd += 10;
      return Promise.resolve({ timePos: 0, buffering: true, cacheEnd });
    });
    const sc = makeReconciler();
    sc.start();

    // 60s in: still inside the load grace — a slow-but-alive stream may not
    // have started yet and must not be reloaded early.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStallRecover).not.toHaveBeenCalled();

    // Past the grace the pin is real: one reload per window, then the bounded
    // error — the user never gets an endless silent download.
    await vi.advanceTimersByTimeAsync(
      STALL_LOAD_GRACE_MS -
        60_000 +
        (STALL_RECOVERY_MAX_ATTEMPTS + 1) * STALL_RECOVER_MS,
    );
    expect(onStallRecover).toHaveBeenCalledTimes(STALL_RECOVERY_MAX_ATTEMPTS);
    expect(onStallExhausted).toHaveBeenCalledTimes(1);
    sc.stop();
  });

  it("time-pos null (nothing loaded yet): never progress, never pinned — the grace still bounds the wait", async () => {
    truth = { timePos: null, buffering: true, cacheEnd: null };
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(
      STALL_LOAD_GRACE_MS + STALL_POLL_INTERVAL_MS,
    );

    expect(onStallRecover).toHaveBeenCalledTimes(1);
    expect(onStallRecover).toHaveBeenLastCalledWith(0, 1);
    sc.stop();
  });

  it("truth buffering=false reconciles the spinner every round (settle signal was lost)", async () => {
    truth = { timePos: 42, buffering: false, cacheEnd: 100 };
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(
      STALL_RECONCILE_MS + STALL_POLL_INTERVAL_MS,
    );

    // Rounds that passed the reconcile gate: t=10s and t=15s.
    expect(onReconcileBuffering).toHaveBeenCalledTimes(2);
    expect(onReconcileBuffering).toHaveBeenNthCalledWith(1, false);
    expect(onReconcileBuffering).toHaveBeenNthCalledWith(2, false);
    sc.stop();
  });

  it("truth buffering=true never reconciles the spinner", async () => {
    truth = { timePos: 42, buffering: true, cacheEnd: 100 };
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(
      STALL_RECONCILE_MS + 2 * STALL_POLL_INTERVAL_MS,
    );

    expect(onReconcileBuffering).not.toHaveBeenCalled();
    sc.stop();
  });

  it("isBusy (seek-ack) skips rounds: no query, no recovery while seeking", async () => {
    busy = true;
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(600_000);

    expect(queryTruth).not.toHaveBeenCalled();
    expect(onStallRecover).not.toHaveBeenCalled();
    expect(onStallExhausted).not.toHaveBeenCalled();
    sc.stop();
  });

  it("isActive=false: start() arms nothing; deactivating mid-run silences the rounds", async () => {
    active = false;
    const sc = makeReconciler();
    sc.start();
    expect(vi.getTimerCount()).toBe(0);

    active = true;
    sc.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(STALL_RECONCILE_MS);
    expect(queryTruth).toHaveBeenCalledTimes(1);

    active = false; // paused/ended mid-watch
    const rounds = queryTruth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(queryTruth).toHaveBeenCalledTimes(rounds);
    sc.stop();
  });

  it("a round while !isActive() self-stops the interval (no orphan 5s poller)", async () => {
    const sc = makeReconciler();
    sc.start();
    expect(vi.getTimerCount()).toBe(1);

    active = false; // paused/ended mid-watch
    await vi.advanceTimersByTimeAsync(STALL_POLL_INTERVAL_MS);

    expect(queryTruth).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // the dead round killed its own interval

    // Only the engine's normal re-arm paths (file-loaded / pause=false) may
    // start it again — it must not resurrect itself.
    active = true;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(queryTruth).not.toHaveBeenCalled();
  });

  it("stop(): no further query or callback (idempotent)", async () => {
    const sc = makeReconciler();
    sc.start();
    await vi.advanceTimersByTimeAsync(STALL_RECONCILE_MS);
    expect(queryTruth).toHaveBeenCalledTimes(1);

    sc.stop();
    sc.stop();
    const rounds = queryTruth.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);

    expect(queryTruth).toHaveBeenCalledTimes(rounds);
    expect(onStallRecover).not.toHaveBeenCalled();
    expect(onStallExhausted).not.toHaveBeenCalled();
  });

  it("stop() during an in-flight query drops the late truth (generation guard)", async () => {
    let resolveQuery: (value: StallTruth) => void = () => {};
    queryTruth.mockReturnValue(
      new Promise<StallTruth>((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const sc = makeReconciler();
    sc.start();
    await vi.advanceTimersByTimeAsync(STALL_RECONCILE_MS);
    expect(queryTruth).toHaveBeenCalledTimes(1); // query awaiting the IPC reply

    sc.stop();
    resolveQuery({ timePos: 42, buffering: false, cacheEnd: 100 });
    await vi.advanceTimersByTimeAsync(0);

    expect(onReconcileBuffering).not.toHaveBeenCalled();
    expect(onStallRecover).not.toHaveBeenCalled();
  });

  it("reset(): re-anchors the window and clears the attempt budget (new track)", async () => {
    const sc = makeReconciler();
    sc.start();

    await vi.advanceTimersByTimeAsync(
      STALL_RECOVER_MS - STALL_POLL_INTERVAL_MS,
    );
    expect(onStallRecover).not.toHaveBeenCalled(); // 70s: window not spent

    sc.reset(); // beginTrack: fresh track starts a fresh window
    await vi.advanceTimersByTimeAsync(
      STALL_RECOVER_MS - STALL_POLL_INTERVAL_MS,
    );
    expect(onStallRecover).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STALL_POLL_INTERVAL_MS);
    expect(onStallRecover).toHaveBeenCalledTimes(1);
    expect(onStallRecover).toHaveBeenLastCalledWith(42, 1);
    sc.stop();
  });

  it("noteTick: a frozen re-push never extends the window; a changed value re-anchors it", async () => {
    const sc = makeReconciler();
    sc.start();
    sc.noteTick(42); // baseline only

    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(STALL_POLL_INTERVAL_MS);
      sc.noteTick(42); // frozen backfill re-push — must not mask the pin
    }
    expect(onStallRecover).toHaveBeenCalledTimes(1); // pinned despite the re-pushes

    onStallRecover.mockClear();
    truth = { timePos: 60, buffering: true, cacheEnd: 100 };
    sc.noteTick(60); // real progress — the window re-anchors
    await vi.advanceTimersByTimeAsync(
      STALL_RECOVER_MS - STALL_POLL_INTERVAL_MS,
    );
    expect(onStallRecover).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STALL_POLL_INTERVAL_MS);
    expect(onStallRecover).toHaveBeenCalledTimes(1);
    sc.stop();
  });

  it("query rejection: warn with context, round counted as progress-less, poller survives", async () => {
    queryError = new Error("mpv is not running (call mpv_spawn first)");
    const sc = makeReconciler();
    sc.start();

    // No observable truth at all: the playhead state is unknown, so the load
    // grace applies (the reconciler cannot tell a wedged load from a slow one
    // without a single time-pos observation) — still bounded, still logged.
    await vi.advanceTimersByTimeAsync(
      STALL_LOAD_GRACE_MS + STALL_POLL_INTERVAL_MS,
    );

    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "mpvProtocol" }),
    );
    const message = vi.mocked(captureError).mock.calls[0]?.[0]?.message ?? "";
    expect(message).toContain("stall-reconcile");
    // Never observed progress → the pin window is spent → one recovery, with
    // the last known position (none) as the resume target.
    expect(onStallRecover).toHaveBeenCalledTimes(1);
    expect(onStallRecover).toHaveBeenLastCalledWith(0, 1);
    expect(onReconcileBuffering).not.toHaveBeenCalled();
    sc.stop();
  });

  it("start() while running does not stack a second interval", () => {
    const sc = makeReconciler();
    sc.start();
    sc.start();

    expect(vi.getTimerCount()).toBe(1);
    sc.stop();
  });
});

describe("stall reconciler constants (locked tuning)", () => {
  it("keeps the bounded self-heal budget", () => {
    expect(STALL_POLL_INTERVAL_MS).toBe(5000);
    expect(STALL_RECONCILE_MS).toBe(10_000);
    // > mpv's --network-timeout (60s) so mpv's own error path wins first.
    expect(STALL_RECOVER_MS).toBe(75_000);
    expect(STALL_RECOVERY_MAX_ATTEMPTS).toBe(2);
    // Load grace for a playhead that never started (>2x the recover window):
    // generous enough for a slow-but-alive first load, far below "app is dead".
    expect(STALL_LOAD_GRACE_MS).toBe(150_000);
  });
});

describe("time-pos nil-drop warn (push path, rate-limited 1/30s)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    resetWarnThrottleForTest();
    vi.mocked(captureError).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a null time-pos push logs a warn with the raw value; repeat within 30s is silent", () => {
    const cb = makeCb();
    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(cb.onTimeUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "mpvProtocol" }),
    );
    const message = vi.mocked(captureError).mock.calls[0]?.[0]?.message ?? "";
    expect(message).toContain("time-pos");

    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
  });

  it("past 30s the next nil push logs again", () => {
    const cb = makeCb();
    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(2);
  });

  it("finite time-pos and other properties never log", () => {
    const cb = makeCb();
    dispatchPropertyEvent({ name: "time-pos", data: 42 }, cb);
    dispatchPropertyEvent({ name: "duration", data: null }, cb);
    dispatchPropertyEvent({ name: "pause", data: null }, cb);
    expect(cb.onTimeUpdate).toHaveBeenCalledWith(42);
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
  });

  it("the watchdog and the push path share one rate-limit window", async () => {
    const cb = makeCb();
    dispatchPropertyEvent({ name: "time-pos", data: null }, cb);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);

    // Watchdog nil round within the same window: still silent.
    const wd = new TimePosWatchdog(
      () => true,
      () => Promise.resolve(null),
      () => {},
    );
    wd.start();
    await vi.advanceTimersByTimeAsync(2 * WATCHDOG_INTERVAL_MS);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);
    expect(vi.mocked(captureError).mock.calls.length).toBeGreaterThanOrEqual(2);
    wd.stop();
  });
});

describe("BufferingTracker v3 settle rules (spinner contract guard)", () => {
  it("request(true) promotes at once; two CHANGED ticks within 1s settle; the watchdog reuses onTimeTick without altering the rule", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true); // playTrack path: immediate promote (S2)
      expect(emitted).toEqual([true]);

      tracker.onTimeTick(1);
      tracker.onTimeTick(1); // same value — not progress (S4)
      vi.advanceTimersByTime(100);
      tracker.onTimeTick(2); // 2nd CHANGED value within 1s
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("request() default keeps the 250ms display delay (seek anti-flash) and settles on two changed ticks", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(); // seek path
      vi.advanceTimersByTime(249);
      expect(emitted).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(emitted).toEqual([true]);

      tracker.onTimeTick(10);
      tracker.onTimeTick(10.5);
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BufferingTracker v4 (mpv paused-for-cache spin-hold)", () => {
  it("a changed tick pair never settles while mpv reports paused-for-cache=true; report(false) is the settle signal", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      expect(emitted).toEqual([true]);

      tracker.reportMpvBuffering(true);
      tracker.onTimeTick(1);
      tracker.onTimeTick(2); // changed within 1s — v3 settled here
      expect(emitted, "tick pair settled during a real stall").toEqual([true]);
      expect(tracker.isShown()).toBe(true);

      tracker.reportMpvBuffering(false); // mpv: stall over
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the safety net re-arms while paused-for-cache=true instead of settling a shown spinner", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      tracker.reportMpvBuffering(true);

      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS);
      expect(emitted, "safety net settled during the stall").toEqual([true]);
      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS); // re-armed net fires too
      expect(emitted).toEqual([true]);
      expect(tracker.isShown()).toBe(true);

      tracker.reportMpvBuffering(false);
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the safety net still settles a shown spinner when mpv is NOT buffering (no regression)", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS);
      expect(emitted).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("report(false) re-opens tick-settle for the next request", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      tracker.reportMpvBuffering(true);
      tracker.onTimeTick(1);
      tracker.onTimeTick(2); // blocked
      tracker.reportMpvBuffering(false); // shown -> settle
      expect(emitted).toEqual([true, false]);

      tracker.request(true);
      tracker.onTimeTick(3);
      tracker.onTimeTick(3.5);
      expect(emitted).toEqual([true, false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() drops the stall flag: a dead mpv report never blocks the next engine's ticks", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      tracker.reportMpvBuffering(true);

      tracker.cancel(); // release path: silent
      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS + 1);
      expect(emitted).toEqual([true]);
      expect(tracker.isShown()).toBe(false);

      tracker.request(true);
      tracker.onTimeTick(1);
      tracker.onTimeTick(2);
      expect(emitted).toEqual([true, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BufferingTracker resetForTrack (track switch, silent session reset)", () => {
  it("clears pending/shown timers without emitting anything", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));

      tracker.request(); // pending: the 250ms anti-flash promote is armed
      tracker.resetForTrack();
      vi.advanceTimersByTime(SPINNER_DELAY_MS + 1);
      expect(emitted, "a pending promote fired after the reset").toEqual([]);
      expect(tracker.isShown()).toBe(false);

      tracker.request(true); // shown: track A's stall spinner
      tracker.reportMpvBuffering(true); // v4 flag + open-ended deadline re-arm
      tracker.resetForTrack();

      vi.advanceTimersByTime(BUFFERING_TIMEOUT_MS * 3);
      expect(emitted, "reset emitted a settle/transition").toEqual([true]);
      expect(tracker.isShown()).toBe(false); // no re-armed deadline survived
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the sticky paused-for-cache flag: the next track settles on its own ticks", () => {
    vi.useFakeTimers();
    try {
      const emitted: boolean[] = [];
      const tracker = new BufferingTracker((b) => emitted.push(b));
      tracker.request(true);
      tracker.reportMpvBuffering(true); // track A stalled: flag now sticky

      tracker.resetForTrack(); // switch to B (beginTrack order: reset, then request)
      tracker.request(true); // B's load promotes the spinner
      tracker.onTimeTick(1);
      tracker.onTimeTick(2); // B's own CHANGED tick pair
      expect(emitted).toEqual([true, true, false]); // settles — flag is gone
      expect(tracker.isShown()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchdog constants", () => {
  it("keeps the locked v3 tuning", () => {
    expect(WATCHDOG_INTERVAL_MS).toBe(1000);
    expect(WATCHDOG_STALE_MS).toBe(1200);
  });
});

describe("dispatchMpvEvent routing (R02-1 / R02-2)", () => {
  it("end-file error carries mpv's error string to onEndFile", () => {
    const cb = makeCb();
    // Realistic mpv string: mpv_error_string() output, not ffmpeg detail.
    dispatchMpvEvent(
      { event: "end-file", reason: "error", error: "loading failed" },
      cb,
    );
    expect(cb.onEndFile).toHaveBeenCalledWith("error", "loading failed");
  });

  it("end-file error without an error field passes null", () => {
    const cb = makeCb();
    dispatchMpvEvent({ event: "end-file", reason: "error" }, cb);
    expect(cb.onEndFile).toHaveBeenCalledWith("error", null);
  });

  it("end-file eof stays a single-argument outcome", () => {
    const cb = makeCb();
    dispatchMpvEvent({ event: "end-file", reason: "eof" }, cb);
    expect(cb.onEndFile).toHaveBeenCalledWith("eof");
  });

  it("ipc-closed routes the engine-closed cause to onEngineClosed", () => {
    const cb = makeCb();
    dispatchMpvEvent({ event: "ipc-closed", reason: "eof", error: null }, cb);
    expect(cb.onEngineClosed).toHaveBeenCalledWith("eof");
    expect(cb.onEndFile).not.toHaveBeenCalled();
  });

  it("ipc-closed without a reason still notifies with a cause string", () => {
    const cb = makeCb();
    dispatchMpvEvent({ event: "ipc-closed" }, cb);
    expect(cb.onEngineClosed).toHaveBeenCalledWith(expect.any(String));
  });
});

describe("classifyEndFileError (R05: proxy status is the primary source)", () => {
  it("proxy 5xx is a retryable network failure — mpv's string cannot overrule it", () => {
    expect(classifyEndFileError("loading failed", 503)).toBe("network");
    expect(classifyEndFileError("unrecognized file format", 502)).toBe(
      "network",
    );
    expect(classifyEndFileError(null, 504)).toBe("network");
  });

  it("proxy 408/429/499 (timeout / rate limit / idle-abort) are retryable network", () => {
    expect(classifyEndFileError("loading failed", 408)).toBe("network");
    expect(classifyEndFileError("something happened", 429)).toBe("network");
    expect(classifyEndFileError(null, 499)).toBe("network");
  });

  it("proxy 4xx (locked/quota/forbidden/not found) stays format (storm guard)", () => {
    expect(classifyEndFileError("loading failed", 403)).toBe("format");
    expect(classifyEndFileError("unrecognized file format", 404)).toBe(
      "format",
    );
    expect(classifyEndFileError(null, 410)).toBe("format");
    expect(classifyEndFileError("something happened", 400)).toBe("format");
  });

  it("no proxy data: mpv's real short strings keep the format default (100% parity)", () => {
    expect(classifyEndFileError(null)).toBe("format");
    expect(classifyEndFileError(undefined)).toBe("format");
    expect(classifyEndFileError("")).toBe("format");
    expect(classifyEndFileError("   ")).toBe("format");
    expect(classifyEndFileError("loading failed")).toBe("format");
    expect(classifyEndFileError("unrecognized file format")).toBe("format");
    expect(classifyEndFileError("something happened", null)).toBe("format");
    expect(classifyEndFileError("Could not open codec.", undefined)).toBe(
      "format",
    );
  });

  it("no proxy data: the transport regex stays as a weak fallback only", () => {
    expect(classifyEndFileError("Connection reset by peer")).toBe("network");
    expect(classifyEndFileError("connection timed out")).toBe("network");
    expect(classifyEndFileError("http error 403")).toBe("format");
  });
});
