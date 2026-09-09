// Pure-mapper tests for the state→event extraction of onNativeState — no
// tauri mocks needed: NativeStateMapper has no imports beyond types, so each
// case drives apply() directly and asserts the queued emit list.
import { describe, expect, it, vi, type Mock } from "vitest";
import { NativeStateMapper } from "./nativeAudioStateMapper";
import type { MapperOptions, MapperResult } from "./nativeAudioStateMapper";
import type { NativeAudioState } from "./nativeAudioTypes";

// READY + playing baseline (ticker shape) — establishes wasPlaying=true and
// fires the play edge when seen for the first time.
const READY_PLAYING: NativeAudioState = {
  status: "playing",
  currentTime: 10,
  duration: 100,
  isPlaying: true,
  buffering: false,
  rate: 1,
};

// The buffering-shaped NOT-playing snapshot: not a pause, wasPlaying must
// survive it (outside a load window).
const BUFFERING_NOT_PLAYING: NativeAudioState = {
  status: "loading",
  currentTime: 42,
  duration: 100,
  isPlaying: false,
  buffering: true,
  rate: 1,
};

// A REAL user pause / focus loss: the only shape that may fire a pause edge.
const REAL_PAUSE: NativeAudioState = {
  status: "idle",
  currentTime: 42,
  duration: 100,
  isPlaying: false,
  buffering: false,
  rate: 1,
};

const ERROR_STATE: NativeAudioState = {
  status: "error",
  currentTime: 42,
  duration: 100,
  isPlaying: false,
  buffering: false,
  rate: 1,
  error: "boom",
};

const RESUMED_PLAYING: NativeAudioState = { ...READY_PLAYING, currentTime: 42 };

// Idle snapshot (cold-start session restore): must not surface a timeupdate.
const IDLE_ZERO: NativeAudioState = {
  status: "idle",
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  buffering: false,
  rate: 1,
};

const opts = (
  over: Partial<
    Pick<MapperOptions, "loadIntentActive" | "currentTrackStreamUnplayable">
  > = {},
): MapperOptions & { onStorePlaying: Mock } => ({
  loadIntentActive: false,
  currentTrackStreamUnplayable: false,
  onStorePlaying: vi.fn(),
  ...over,
});

const events = (r: MapperResult) => r.emit.map((e) => e.event);

describe("NativeStateMapper (extracted from onNativeState, mapping verbatim)", () => {
  it("error + currentTrackStreamUnplayable: error emit carries the m4a hint, then ended parity, wasPlaying reset", () => {
    const mapper = new NativeStateMapper();
    const o = opts({ currentTrackStreamUnplayable: true });

    const r = mapper.apply(null, ERROR_STATE, o);

    expect(r.emit).toEqual([
      {
        event: "error",
        payload: {
          message: "boom (m4a moov-at-end — file không phát trực tiếp được)",
          code: "format_error",
        },
      },
      { event: "ended", payload: undefined },
    ]);

    // wasPlaying was reset by the error path: the next playing snapshot
    // fires a fresh play edge (no store sync ran inside the error branch).
    const r2 = mapper.apply(ERROR_STATE, RESUMED_PLAYING, o);
    expect(events(r2)).toContain("play");
    expect(o.onStorePlaying).toHaveBeenCalledWith(true);
  });

  it("error without streamUnplayable: bare message + ended parity (auto-advance)", () => {
    const mapper = new NativeStateMapper();

    const r = mapper.apply(null, ERROR_STATE, opts());

    expect(r.emit).toEqual([
      { event: "error", payload: { message: "boom", code: "format_error" } },
      { event: "ended", payload: undefined },
    ]);
  });

  it("buffering edges: entering and leaving buffering each emit once", () => {
    const mapper = new NativeStateMapper();
    const o = opts();
    // Freeze the clock inside the throttle window (performance.now() < 200)
    // so no timeupdate muddies the edge assertions.
    const clock = vi.spyOn(performance, "now").mockReturnValue(50);

    try {
      // Establish wasPlaying=true first (the engine's tests feed the READY
      // playing baseline before the dip) so the buffering-exit snapshot
      // fires no phantom play edge — only the buffering edges are asserted.
      mapper.apply(null, READY_PLAYING, o);

      const enter = mapper.apply(READY_PLAYING, BUFFERING_NOT_PLAYING, o);
      expect(enter.emit).toEqual([
        { event: "buffering", payload: { isBuffering: true } },
      ]);

      const exit = mapper.apply(BUFFERING_NOT_PLAYING, READY_PLAYING, o);
      expect(exit.emit).toEqual([
        { event: "buffering", payload: { isBuffering: false } },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("pausedWhileBuffering snapshot outside a load window: no pause emit, wasPlaying survives", () => {
    const mapper = new NativeStateMapper();
    const o = opts();
    // Same frozen-clock trick as the buffering-edges test: keep the throttled
    // tick out of the picture so only play/pause edges are asserted.
    const clock = vi.spyOn(performance, "now").mockReturnValue(50);

    try {
      // Establish wasPlaying=true via the settled playing snapshot.
      mapper.apply(null, READY_PLAYING, o);
      o.onStorePlaying.mockClear();

      // Slow-network stall while logically playing: the buffering edge emits,
      // but NO pause edge and NO store flip may happen.
      const stall = mapper.apply(READY_PLAYING, BUFFERING_NOT_PLAYING, o);
      expect(events(stall)).not.toContain("pause");
      expect(o.onStorePlaying).not.toHaveBeenCalledWith(false);

      // wasPlaying survived the stall: the next SETTLED not-playing snapshot
      // still fires the real pause edge + store sync (self-heal). The
      // buffering→settled transition also carries its own buffering edge.
      const realPause = mapper.apply(BUFFERING_NOT_PLAYING, REAL_PAUSE, o);
      expect(events(realPause)).toEqual(["buffering", "pause"]);
      expect(o.onStorePlaying).toHaveBeenCalledTimes(1);
      expect(o.onStorePlaying).toHaveBeenCalledWith(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("isPlaying edge: first settled playing snapshot emits play + syncs the store", () => {
    const mapper = new NativeStateMapper();
    const o = opts();

    const r = mapper.apply(null, READY_PLAYING, o);

    expect(events(r)).toContain("play");
    expect(o.onStorePlaying).toHaveBeenCalledTimes(1);
    expect(o.onStorePlaying).toHaveBeenCalledWith(true);
  });

  it("timeupdate throttle: two snapshots <200ms apart emit only one timeupdate", () => {
    const mapper = new NativeStateMapper();
    const o = opts();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);

    try {
      const first = mapper.apply(null, READY_PLAYING, o);
      expect(events(first).filter((e) => e === "timeupdate")).toHaveLength(1);

      // 100ms later (throttle window still open): no second timeupdate.
      clock.mockReturnValue(1_100);
      const second = mapper.apply(
        READY_PLAYING,
        { ...READY_PLAYING, currentTime: 11 },
        o,
      );
      expect(events(second).filter((e) => e === "timeupdate")).toHaveLength(0);

      // 201ms after the last emitted tick: the throttle re-opens.
      clock.mockReturnValue(1_201);
      const third = mapper.apply(
        { ...READY_PLAYING, currentTime: 11 },
        { ...READY_PLAYING, currentTime: 12 },
        o,
      );
      expect(events(third).filter((e) => e === "timeupdate")).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("idle snapshot {0,0}: no timeupdate (restored duration/position seed protected)", () => {
    const mapper = new NativeStateMapper();

    const r = mapper.apply(null, IDLE_ZERO, opts());

    expect(events(r).filter((e) => e === "timeupdate")).toHaveLength(0);
  });
});
