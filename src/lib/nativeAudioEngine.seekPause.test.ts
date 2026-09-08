// @vitest-environment jsdom
// Regression: seeking while playing must not surface Media3's transient
// STATE_BUFFERING as a user pause. Media3 1.4.1 (ExoPlayerImplInternal
// .seekToPeriodPosition) calls stopRenderers() + setState(STATE_BUFFERING)
// on EVERY seek from READY — even fully-buffered targets — so the plugin
// pushes {isPlaying:false, buffering:true} mid-seek. The bridge used to read
// that as a pause edge (emit "pause" + setIsPlaying(false)), which the
// PlayerBar play/pause sync effect turned into a REAL engine.pause() →
// silent stop. A short seek-intent window (mirroring Kotlin's
// pendingSeekState mask) suppresses only buffering pause edges; real pauses
// (buffering=false) still sync the store exactly as before.
import { describe, expect, it, vi, beforeEach } from "vitest";
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

const listener = () =>
  addPluginListenerMock.mock.calls[0]?.[2] as (s: unknown) => void;

// READY + playing baseline (ticker shape) — establishes wasPlaying=true and
// the store's isPlaying=true before the seek dispatches.
const READY_PLAYING = {
  status: "playing",
  currentTime: 10,
  duration: 100,
  isPlaying: true,
  buffering: false,
  rate: 1,
};

// The seek_to resolve snapshot: Kotlin's pendingSeekState (shouldResume=true)
// masks isPlaying to true and status to "playing" even while ExoPlayer dips
// into BUFFERING (NativeAudioPlugin snapshotLocked effective* fields).
const MASKED_SEEK_RESOLVE = {
  status: "playing",
  currentTime: 42,
  duration: 100,
  isPlaying: true,
  buffering: true,
  rate: 1,
};

// The transient Media3 seek-BUFFERING snapshot: the mask is already cleared
// (pendingSeekState dropped on DISCONTINUITY_REASON_SEEK) but ExoPlayer has
// not reached READY yet → isPlaying=false, buffering=true, status "loading".
// THIS is the snapshot that used to fake a pause edge.
const TRANSIENT_SEEK_BUFFERING = {
  status: "loading",
  currentTime: 42,
  duration: 100,
  isPlaying: false,
  buffering: true,
  rate: 1,
};

// Playback actually resumed: READY + playing (real isPlaying, no mask).
const RESUMED_PLAYING = { ...READY_PLAYING, currentTime: 42 };

// A REAL user pause / focus loss: not buffering, isPlaying=false. Must
// always emit "pause" and sync the store, window or no window.
const REAL_PAUSE = {
  status: "idle",
  currentTime: 42,
  duration: 100,
  isPlaying: false,
  buffering: false,
  rate: 1,
};

describe("nativeAudioEngine.seekPause (seek-intent window vs fake pause)", () => {
  it("does not treat the transient seek-BUFFERING snapshot as a pause — store keeps isPlaying=true", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("play", () => seen.push("play"));

    // Baseline: first isPlaying:true push emits the cold-start "play" edge.
    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    // Seek resolves with the masked snapshot — no pause edge yet.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === SEEK_CMD
        ? Promise.resolve(MASKED_SEEK_RESOLVE)
        : Promise.resolve({}),
    );
    await engine.seek(42);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalledWith(false);

    // ExoPlayer processed the seek: the mask is gone, Media3 is in
    // STATE_BUFFERING with isPlaying=false. The old bridge read this as a
    // user pause ("pause" emit + setIsPlaying(false) → PlayerBar's effect
    // really paused the player). The seek-intent window must swallow ONLY
    // this buffering-shaped pause edge.
    listener()(TRANSIENT_SEEK_BUFFERING);
    expect(seen).not.toContain("pause");
    expect(setStateMock).not.toHaveBeenCalledWith(false);
  });

  it("closes the window when playback resumes (isPlaying=true, not buffering) — play edge flows", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));
    engine.on("play", () => seen.push("play"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();
    seen.length = 0;

    invokeMock.mockImplementation((cmd: string) =>
      cmd === SEEK_CMD
        ? Promise.resolve(MASKED_SEEK_RESOLVE)
        : Promise.resolve({}),
    );
    await engine.seek(42);
    listener()(TRANSIENT_SEEK_BUFFERING);
    expect(seen).toEqual([]);

    // READY + real playback: the store never flipped during the suppressed
    // dip, so resume is NOT a visible play edge — no phantom "play" may
    // fire, and the store must stay untouched.
    listener()(RESUMED_PLAYING);
    expect(seen).toEqual([]);
    expect(setStateMock).not.toHaveBeenCalled();

    // The window is closed now: a subsequent buffering-shaped pause snapshot
    // (an unrelated stall while playing) must surface as a pause again.
    listener()(TRANSIENT_SEEK_BUFFERING);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });

  it("still emits a REAL pause (buffering=false) after the window — never swallowed", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();

    invokeMock.mockImplementation((cmd: string) =>
      cmd === SEEK_CMD
        ? Promise.resolve(MASKED_SEEK_RESOLVE)
        : Promise.resolve({}),
    );
    await engine.seek(42);
    listener()(TRANSIENT_SEEK_BUFFERING);

    // User pause / audio-focus loss right after the seek: buffering=false →
    // a real pause, must emit even though the seek window may still be open.
    listener()(REAL_PAUSE);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });

  it("a rejected seek closes the window — a later transient snapshot surfaces as a pause", async () => {
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

    // The window must be closed by the rejection: a late transient
    // buffering snapshot is no longer attributable to this seek and must
    // surface as a pause (otherwise a wedged seek would mute pause edges
    // until the stale timeout).
    listener()(TRANSIENT_SEEK_BUFFERING);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });

  it("release() closes the window — a late transient snapshot still emits pause", async () => {
    await engine.initOnce();
    const seen: string[] = [];
    engine.on("pause", () => seen.push("pause"));

    listener()(READY_PLAYING);
    setStateMock.mockClear();

    // Seek dispatch opens the window (the turn may still be queued on the
    // playChain FIFO when release() lands).
    invokeMock.mockImplementation((cmd: string) =>
      cmd === SEEK_CMD
        ? Promise.resolve(MASKED_SEEK_RESOLVE)
        : Promise.resolve({}),
    );
    void engine.seek(42);
    await engine.release();

    // Logout/stop: any subsequent native snapshot must sync the store
    // exactly as before — no seek window may suppress the pause edge.
    listener()(TRANSIENT_SEEK_BUFFERING);
    expect(seen).toEqual(["pause"]);
    expect(setStateMock).toHaveBeenCalledWith(false);
  });
});
