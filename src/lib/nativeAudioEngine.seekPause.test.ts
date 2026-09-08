// @vitest-environment jsdom
// Regression: Media3 collapses isPlaying to false while STATE_BUFFERING
// (isPlaying = STATE_READY && playWhenReady && !suppressed), so the plugin
// pushes {isPlaying:false, buffering:true} whenever the player stalls —
// after a seek (ExoPlayerImplInternal.seekToPeriodPosition enters BUFFERING
// on EVERY seek from READY) or on a slow network. The bridge used to hide
// those snapshots behind a 2s seek-intent window; once the window expired
// (buffering longer than 2s) the fake pause slipped through, the store
// flipped, and PlayerBar's play/pause sync effect really paused the engine —
// silent stop. The bridge now follows pure playback intent: ONLY a settled
// {isPlaying:false, buffering:false} snapshot is a pause edge; buffering
// snapshots never fire the edge, never flip the store and never clobber
// wasPlaying, so a user pause mid-buffer self-heals (the edge lands when
// buffering completes) with NO time-window heuristic at all.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { NativeAudioEngine } from "./nativeAudioBridge";

// IS_MOBILE is a module-level constant read at import time — the platform
// mock must be installed BEFORE the bridge module is imported (same harness
// as nativeAudioBridge.test.ts, including the live getter).
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

const invokeMock = vi.hoisted(() => vi.fn());
const addPluginListenerMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  addPluginListener: addPluginListenerMock,
}));

const setStateMock = vi.hoisted(() => vi.fn());
vi.mock("../store/playerStore", () => ({
  usePlayerStore: { getState: () => ({ setIsPlaying: setStateMock }) },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const SEEK_CMD = "plugin:native-audio|seek_to";

let bridge: typeof import("./nativeAudioBridge");
let engine: NativeAudioEngine;

beforeEach(async () => {
  invokeMock.mockReset();
  addPluginListenerMock.mockReset();
  setStateMock.mockReset();
  addPluginListenerMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue({});
  platformMock.IS_MOBILE = true;
  // Fresh module instance per test — the engine is a singleton by design.
  vi.resetModules();
  bridge = await import("./nativeAudioBridge");
  engine = bridge.nativeAudioEngine;
});

// Test 3 arms fake timers to prove staleness-independence; harmless for the
// rest (they never schedule timers).
afterEach(() => {
  vi.useRealTimers();
});

const listener = () =>
  addPluginListenerMock.mock.calls[0]?.[2] as (s: unknown) => void;

// READY + playing baseline (ticker shape) — establishes wasPlaying=true and
// the store's isPlaying=true before the edge under test arrives.
const READY_PLAYING = {
  status: "playing",
  currentTime: 10,
  duration: 100,
  isPlaying: true,
  buffering: false,
  rate: 1,
};

// The seek_to resolve snapshot: Kotlin's pendingSeekState (shouldResume=true)
// masks isPlaying to true while ExoPlayer dips into BUFFERING (snapshotLocked
// effective* fields) — playing-intent shape, no edge either way.
const SEEK_RESOLVE = {
  status: "playing",
  currentTime: 42,
  duration: 100,
  isPlaying: true,
  buffering: true,
  rate: 1,
};

// The buffering-shaped NOT-playing snapshot: ExoPlayer is in STATE_BUFFERING
// while the user is still logically playing (seek dip or slow-network stall).
// THIS is the snapshot the old windowed bridge eventually read as a pause.
const BUFFERING_NOT_PLAYING = {
  status: "loading",
  currentTime: 42,
  duration: 100,
  isPlaying: false,
  buffering: true,
  rate: 1,
};

// Playback actually resumed: READY + playing (real isPlaying, no mask).
const RESUMED_PLAYING = { ...READY_PLAYING, currentTime: 42 };

// A REAL user pause / focus loss: not buffering, isPlaying=false. The ONLY
// shape that may fire a pause edge and flip the store.
const REAL_PAUSE = {
  status: "idle",
  currentTime: 42,
  duration: 100,
  isPlaying: false,
  buffering: false,
  rate: 1,
};

// Media3's real load shape inside a JS-initiated playTrack chain: isPlaying
// stays false while buffering — it only flips true at READY.
const LOADING_B = {
  status: "loading",
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  buffering: true,
  rate: 1,
};

const ENDED_STATE = {
  status: "ended",
  currentTime: 100,
  duration: 100,
  isPlaying: false,
  buffering: false,
  rate: 1,
};

const ERROR_STATE = {
  status: "error",
  currentTime: 42,
  duration: 100,
  isPlaying: false,
  buffering: false,
  rate: 1,
  error: "boom",
};

const resolveSeekWith = (state: object | Promise<never>) => {
  invokeMock.mockImplementation((cmd: string) =>
    cmd === SEEK_CMD ? Promise.resolve(state) : Promise.resolve({}),
  );
};

describe("nativeAudioEngine.seekPause (intent-based pause edges vs Media3 buffering)", () => {
  it("does not treat the transient seek-BUFFERING snapshot as a pause — and resume fires no phantom play edge", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("play", () => seen.push("play"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    resolveSeekWith(SEEK_RESOLVE);
    await engine.seek(42);

    // The buffering-shaped NOT-playing snapshot mid-seek is the seek, not a
    // pause: no edge, store untouched (no setIsPlaying(false)).
    listener()(BUFFERING_NOT_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalledWith(false);

    // The store never flipped during the dip, so the resumed READY tick
    // must NOT surface as a phantom "play" — and wasPlaying survived.
    listener()(RESUMED_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalled();
  });

  it("a stall while playing (no seek in flight) never fires a pause edge", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("play", () => seen.push("play"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    // Slow network mid-playback: no seek intent exists at all, yet the
    // snapshot is buffering-shaped. Old windowed code had nothing masking
    // this and paused for real.
    listener()(BUFFERING_NOT_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalledWith(false);

    // Buffering completes with the user still playing: no phantom edge.
    listener()(RESUMED_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalled();
  });

  it("extended buffering far past the old 2s seek window never pauses (stale-timeout independent)", async () => {
    vi.useFakeTimers();
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("play", () => seen.push("play"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    resolveSeekWith(SEEK_RESOLVE);
    await engine.seek(42);

    // Reproduce the user bug: buffering outlives the old SEEK_INTENT_STALE_MS
    // (2s). On the old engine the stale timer expired between the snapshots
    // and the NEXT buffering snapshot fired a real pause + store flip.
    listener()(BUFFERING_NOT_PLAYING);
    vi.advanceTimersByTime(2_500);
    listener()(BUFFERING_NOT_PLAYING);
    vi.advanceTimersByTime(2_500);
    listener()(BUFFERING_NOT_PLAYING);

    // Not a single pause edge across the whole slow-buffer stretch, and the
    // store was never touched (no flip, no phantom re-affirm).
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalled();

    // Buffering completes with the user still logically playing: nothing.
    listener()(RESUMED_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalled();
  });

  it("a real pause right after a buffering stall still fires (wasPlaying preserved through buffering)", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();

    resolveSeekWith(SEEK_RESOLVE);
    await engine.seek(42);
    listener()(BUFFERING_NOT_PLAYING);
    expect(seen).toEqual([]);

    // User pauses while buffering: the next {isPlaying:false,
    // buffering:false} snapshot is a REAL pause and must not be swallowed.
    listener()(REAL_PAUSE);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledTimes(1);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });

  it("user pause mid-buffer self-heals: the edge lands when buffering settles", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    listener()(BUFFERING_NOT_PLAYING);
    expect(seen).toEqual([]);

    // Resolve the pause command with NO state so the edge below can only
    // come from the pushed settled snapshot (an empty resolve object would
    // itself read as a settled pause shape).
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await engine.pause();
    listener()(REAL_PAUSE);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });

  it("rapid double seek coalesces latest-wins and no pause edge appears mid-flight", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("play", () => seen.push("play"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;
    invokeMock.mockClear();
    resolveSeekWith(SEEK_RESOLVE);

    // Two seeks in quick succession: latest-wins coalescing (CF-2) fires
    // only the newest seek_to.
    await Promise.allSettled([engine.seek(1), engine.seek(42)]);
    const seekCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === SEEK_CMD);
    expect(seekCalls).toEqual([[SEEK_CMD, { position: 42 }]]);

    // The buffering dip behind the settled seek is not a pause (no window
    // machinery involved — pure snapshot shape).
    listener()(BUFFERING_NOT_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalledWith(false);

    // And a real pause afterwards still syncs the store exactly once.
    listener()(REAL_PAUSE);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });

  it("load intent: buffering snapshots during playTrack never pause and READY re-affirms the play edge", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("play", () => seen.push("play"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    // Track switch: set_source/play resolve with the load's buffering shape.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:native-audio|set_source" ||
      cmd === "plugin:native-audio|play"
        ? Promise.resolve(LOADING_B)
        : Promise.resolve({}),
    );
    await engine.playTrack({
      id: "track-B",
      title: "B",
      artist: "",
      streamUrl: "",
    });

    // Load buffering is not a pause: no edge, store intent untouched.
    expect(seen).not.toContain("pause");
    expect(setStateMock).not.toHaveBeenCalledWith(false);

    // READY for track B: the play edge flows and re-affirms isPlaying=true
    // (load-window snapshots keep the old wasPlaying clobber).
    listener()(RESUMED_PLAYING);
    expect(seen).toContain("play");
    expect(setStateMock).toHaveBeenCalledWith(true);
  });

  it("a rejected seek still rejects and a later real pause still syncs the store", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();

    invokeMock.mockImplementation((cmd: string) =>
      cmd === SEEK_CMD
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({}),
    );
    await expect(engine.seek(42)).rejects.toThrow("boom");

    // A late transient buffering snapshot after the failed seek is still
    // buffering-shaped: no pause edge, store untouched.
    listener()(BUFFERING_NOT_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalledWith(false);

    // The next REAL pause still has its edge.
    listener()(REAL_PAUSE);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });

  it("release() then a late transient stays inert while a real pause still syncs", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();

    resolveSeekWith(SEEK_RESOLVE);
    void engine.seek(42);
    // Release's pause command must resolve with NO state: an empty resolve
    // object reads as a settled pause shape and would fire its own edge,
    // masking the late-transient behavior under test.
    invokeMock.mockImplementation(() => Promise.resolve(undefined));
    await engine.release();

    // Logout/stop: a late buffering snapshot must not fake a pause edge.
    listener()(BUFFERING_NOT_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalledWith(false);

    // A settled not-buffering pause still syncs the store.
    listener()(REAL_PAUSE);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });

  it("ended: emits ended without a pause edge and resets wasPlaying for the next track", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("ended", () => seen.push("ended"));
    engine.on("play", () => seen.push("play"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    listener()(ENDED_STATE);
    expect(seen).toEqual(["ended"]);
    expect(setStateMock).not.toHaveBeenCalledWith(false);

    // wasPlaying was reset by the ended path: the next track's READY playing
    // snapshot fires a fresh play edge (auto-advance parity).
    listener()(RESUMED_PLAYING);
    expect(seen).toEqual(["ended", "play"]);
    expect(setStateMock).toHaveBeenCalledWith(true);
  });

  it("error: emits error + ended (auto-advance parity), no pause edge, wasPlaying reset", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    const errors: Array<{ message: string; code: string }> = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("ended", () => seen.push("ended"));
    engine.on("play", () => seen.push("play"));
    engine.on("error", (e) => errors.push(e));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    listener()(ERROR_STATE);
    expect(errors).toEqual([{ message: "boom", code: "format_error" }]);
    expect(seen).toEqual(["ended"]);
    expect(setStateMock).not.toHaveBeenCalled();

    // wasPlaying was reset by the error path: the next playing snapshot
    // fires a fresh play edge.
    listener()(RESUMED_PLAYING);
    expect(seen).toEqual(["ended", "play"]);
    expect(setStateMock).toHaveBeenCalledWith(true);
  });
});
