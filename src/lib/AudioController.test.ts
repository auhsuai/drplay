// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Track } from "../types";
import { usePlayerStore } from "../store/playerStore";

vi.mock("../store/playerStore", () => ({
  usePlayerStore: {
    getState: vi.fn(() => ({ setIsPlaying: vi.fn() })),
  },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

// MediaError.code values per MDN MediaError constants (lib.dom declares them
// on the global `MediaError` constructor, but jsdom does not implement that
// global — `typeof MediaError === "undefined"` — so the tests carry the
// numeric values instead of referencing it).
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

type FakeAudio = {
  seq: string[];
  paused: boolean;
  src: string;
  currentTime: number;
  duration: number;
  readyState: number;
  volume: number;
  error: { code: number; message: string } | null;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _listeners: Record<string, ((e: Event) => void)[]>;
};

const audioElements: FakeAudio[] = [];

function makeFakeAudio(): FakeAudio {
  const listeners: Record<string, ((e: Event) => void)[]> = {};
  const seq: string[] = [];
  const audio: FakeAudio = {
    seq,
    paused: true,
    src: "",
    currentTime: 0,
    duration: 0,
    readyState: 0,
    volume: 1,
    error: null,
    play: vi.fn(function (this: FakeAudio) {
      this.paused = false;
      seq.push("play");
    }),
    pause: vi.fn(function (this: FakeAudio) {
      this.paused = true;
      seq.push("pause");
    }),
    load: vi.fn(() => {
      seq.push("load");
    }),
    removeAttribute: vi.fn(function (this: FakeAudio, name: string) {
      if (name === "src") {
        this.src = "";
        seq.push("removeAttribute:src");
      }
    }),
    setAttribute: vi.fn(),
    addEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
      (listeners[type] ??= []).push(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    }),
    _listeners: listeners,
  };
  return audio;
}

function fireError(audio: FakeAudio) {
  for (const fn of audio._listeners["error"] ?? []) fn(new Event("error"));
}

function fireLoadedMetadata(audio: FakeAudio) {
  for (const fn of audio._listeners["loadedmetadata"] ?? [])
    fn(new Event("loadedmetadata"));
}

function fireProgress(audio: FakeAudio) {
  for (const fn of audio._listeners["progress"] ?? [])
    fn(new Event("progress"));
}

function fireNative(audio: FakeAudio, type: string) {
  for (const fn of audio._listeners[type] ?? []) fn(new Event(type));
}

function audioEl(index: number): FakeAudio {
  const el = audioElements[index];
  if (el === undefined)
    throw new Error(`expected audio element at index ${String(index)}`);
  return el;
}

describe("AudioController retry lifecycle", () => {
  let AudioControllerClass: typeof import("../lib/AudioController").AudioController;

  beforeEach(async () => {
    vi.useFakeTimers();
    audioElements.length = 0;
    vi.stubGlobal(
      "Audio",
      vi.fn(function () {
        const el = makeFakeAudio();
        audioElements.push(el);
        return el;
      }),
    );
    // Fresh module each test so the singleton + retry state never leaks.
    vi.resetModules();
    const mod = await import("../lib/AudioController");
    AudioControllerClass = mod.AudioController;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const trackA: Track = {
    id: "A",
    title: "Track A",
    artist: "Artist",
    streamUrl: "/drive-stream/A",
  };
  const trackB: Track = {
    id: "B",
    title: "Track B",
    artist: "Artist",
    streamUrl: "/drive-stream/B",
  };

  it("B1 regression: stale retry timer does not touch the new track after a switch", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    ctrl.on("error", errorHandler);

    await ctrl.playTrack(trackA);
    const audioA = audioEl(1); // playTrack flips activeIndex 0 -> 1
    fireError(audioA);

    await ctrl.playTrack(trackB);
    const audioB = audioEl(0); // now active

    await vi.advanceTimersByTimeAsync(2000);

    // Only the original 'network_interrupted' emit — the stale timer must not
    // schedule anything else on the new track. removeAttribute was called
    // exactly once: the legitimate cleanup of the empty audio1 during
    // playTrack(A) — a zombie retry would add a second call.
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(audioB.removeAttribute).toHaveBeenCalledTimes(1);
    expect(audioB.src).not.toContain("retry=");
    expect(audioB.play).toHaveBeenCalledTimes(1); // only the playTrack(B) call
  });

  it("B1 variant: retry still fires for the still-active track and restores position", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    const audio = audioEl(1);
    audio.currentTime = 5;

    fireError(audio);
    await vi.advanceTimersByTimeAsync(2000);

    expect(audio.src).toContain("retry=");
    expect(audio.load).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();

    fireLoadedMetadata(audio);
    expect(audio.currentTime).toBe(5);
    expect(audio.removeEventListener).toHaveBeenCalled();
  });

  it("B1 variant: retries are capped (retryCount < 3) — an error past the cap gives up and schedules no zombie retry", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    const endedHandler = vi.fn();
    ctrl.on("error", errorHandler);
    ctrl.on("ended", endedHandler);

    await ctrl.playTrack(trackA);
    const audio = audioEl(1);

    for (let i = 0; i < 4; i++) fireError(audio);
    await vi.advanceTimersByTimeAsync(10_000);

    const networkMsgs = errorHandler.mock.calls.filter(
      (c) =>
        (c[0] as { code: string } | undefined)?.code === "network_interrupted",
    );
    const formatMsgs = errorHandler.mock.calls.filter(
      (c) => (c[0] as { code: string } | undefined)?.code === "format_error",
    );
    expect(networkMsgs).toHaveLength(2); // retryCount 1 and 2 are < 3
    expect(formatMsgs).toHaveLength(2); // retryCount 3 and 4 give up
    expect(endedHandler).toHaveBeenCalledTimes(2);
    // After giving up, no pending retry may fire: play() was only called by
    // the original playTrack.
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).not.toContain("retry=");
  });

  it("Task B regression: MEDIA_ERR_DECODE (3) gives up immediately — format_error + ended, no retry (previously retried 3x wasting ~6s)", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    const endedHandler = vi.fn();
    ctrl.on("error", errorHandler);
    ctrl.on("ended", endedHandler);

    await ctrl.playTrack(trackA);
    const audio = audioEl(1);
    audio.error = { code: MEDIA_ERR_DECODE, message: "decode" };

    fireError(audio);
    await vi.advanceTimersByTimeAsync(10_000);

    const codes = errorHandler.mock.calls.map(
      (c) => (c[0] as { code: string }).code,
    );
    expect(codes).toEqual(["format_error"]); // exactly one error emit, no network retries
    expect(endedHandler).toHaveBeenCalledTimes(1); // skip the track right away
    expect(audio.play).toHaveBeenCalledTimes(1); // no retry play() happened
    expect(audio.src).not.toContain("retry=");
  });

  it("Task B variant: MEDIA_ERR_SRC_NOT_SUPPORTED (4) skips immediately like DECODE", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    const endedHandler = vi.fn();
    ctrl.on("error", errorHandler);
    ctrl.on("ended", endedHandler);

    await ctrl.playTrack(trackA);
    const audio = audioEl(1);
    audio.error = { code: MEDIA_ERR_SRC_NOT_SUPPORTED, message: "unsupported" };

    fireError(audio);
    await vi.advanceTimersByTimeAsync(10_000);

    const codes = errorHandler.mock.calls.map(
      (c) => (c[0] as { code: string }).code,
    );
    expect(codes).toEqual(["format_error"]);
    expect(endedHandler).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).not.toContain("retry=");
  });

  it("Task B variant: MEDIA_ERR_ABORTED (1) is silent — no error toast, no ended, no retry (user/seek cancelled the fetch)", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    const endedHandler = vi.fn();
    ctrl.on("error", errorHandler);
    ctrl.on("ended", endedHandler);

    await ctrl.playTrack(trackA);
    const audio = audioEl(1);
    audio.error = { code: MEDIA_ERR_ABORTED, message: "aborted" };

    fireError(audio);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(errorHandler).not.toHaveBeenCalled();
    expect(endedHandler).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1); // no retry play()
    expect(audio.src).not.toContain("retry=");
  });

  it("Task B variant: MEDIA_ERR_NETWORK (2) keeps the existing retry path", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    ctrl.on("error", errorHandler);

    await ctrl.playTrack(trackA);
    const audio = audioEl(1);
    audio.currentTime = 5;
    audio.error = { code: MEDIA_ERR_NETWORK, message: "network" };

    fireError(audio);
    await vi.advanceTimersByTimeAsync(2000);

    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "network_interrupted" }),
    );
    expect(audio.src).toContain("retry=");
    fireLoadedMetadata(audio);
    expect(audio.currentTime).toBe(5); // position restored after retry
  });

  it("Task B variant: null mediaError (error event without MediaError set) keeps the current retry behavior", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const errorHandler = vi.fn();
    ctrl.on("error", errorHandler);

    await ctrl.playTrack(trackA);
    const audio = audioEl(1);

    fireError(audio);
    await vi.advanceTimersByTimeAsync(2000);

    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ code: "network_interrupted" }),
    );
    expect(audio.src).toContain("retry=");
  });

  it("safePlay: calls audio.play() when resuming a paused track (same-track path)", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    const audio = audioEl(1);

    audio.paused = true;
    audio.play.mockClear();

    await ctrl.playTrack(trackA);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("safePlay: calls audio.play() when toggling play on a paused track", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    const audio = audioEl(1);

    audio.paused = true;
    audio.play.mockClear();

    ctrl.togglePlay();
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("safePlay: playTrack for a new track calls audio.play() on the new element", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    const audio1 = audioEl(1); // active after first playTrack
    audio1.play.mockClear();

    await ctrl.playTrack(trackB);
    const audio2 = audioEl(0); // active after flip

    expect(audio2.play).toHaveBeenCalledTimes(1);
    expect(audio1.play).not.toHaveBeenCalled(); // old element not played again
  });

  it("Task C regression: pause event from the old element during a track switch never emits 'pause' (session must not save 'new track @ old position')", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const pauseHandler = vi.fn();
    ctrl.on("pause", pauseHandler);

    await ctrl.playTrack(trackA);
    const oldAudio = audioEl(1);
    oldAudio.currentTime = 42; // old element's playhead

    // usePlayer has ALREADY set store.currentTrack to the NEW track before
    // PlayerBar's effect calls playTrack — this mirrors the real call order.
    const setIsPlaying = vi.fn();
    vi.mocked(usePlayerStore.getState).mockReturnValue({
      setIsPlaying,
    } as unknown as ReturnType<typeof usePlayerStore.getState>);

    // Worst-case delivery: pause() dispatches its native pause event
    // synchronously ("sent once the pause() method returns" — MDN), i.e.
    // while the old element is still considered active. If the guard lets
    // this through, saveSession would persist store.currentTrack (track B)
    // with getCurrentTime() (old element, 42s) = "B @ 42".
    oldAudio.pause.mockImplementation(function (this: FakeAudio) {
      this.paused = true;
      this.seq.push("pause");
      fireNative(this, "pause");
    });

    await ctrl.playTrack(trackB);

    expect(pauseHandler).not.toHaveBeenCalled();
    // No isPlaying false-flash either: the old element's pause must not
    // reach the store while switching.
    expect(setIsPlaying).not.toHaveBeenCalled();
  });

  it("Task C variant: a queued pause event from the released element (delivered after playTrack returns) is dropped by the active-element guard", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const pauseHandler = vi.fn();
    ctrl.on("pause", pauseHandler);

    await ctrl.playTrack(trackA);
    const oldAudio = audioEl(1);
    oldAudio.currentTime = 42;

    await ctrl.playTrack(trackB);
    fireNative(oldAudio, "pause"); // queued task delivered late

    expect(pauseHandler).not.toHaveBeenCalled();
  });

  it("Task C variant: manual pause on the ACTIVE element still emits 'pause' (user pause → session save path intact)", async () => {
    const ctrl = AudioControllerClass.getInstance();
    const pauseHandler = vi.fn();
    ctrl.on("pause", pauseHandler);

    await ctrl.playTrack(trackA);
    const active = audioEl(1);
    active.currentTime = 12;

    fireNative(active, "pause");

    expect(pauseHandler).toHaveBeenCalledTimes(1);
  });

  it('B2 regression: old audio gets load() immediately after removeAttribute("src") when switching tracks', async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    await ctrl.playTrack(trackB);

    for (const el of audioElements) {
      const iPause = el.seq.indexOf("pause");
      const iRemove = el.seq.indexOf("removeAttribute:src");
      expect(iPause).toBeGreaterThanOrEqual(0);
      expect(iRemove).toBeGreaterThan(iPause);
      // The MDN 3-step release: pause -> removeAttribute('src') -> load()
      expect(el.seq[iRemove + 1]).toBe("load");
    }
  });

  it("B3 regression: release() releases both elements (pause + removeAttribute + load) and resets state", async () => {
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);

    ctrl.release();

    for (const el of audioElements) {
      const iPause = el.seq.indexOf("pause");
      const iRemove = el.seq.indexOf("removeAttribute:src");
      const iLoad = el.seq.lastIndexOf("load");
      expect(iPause).toBeGreaterThanOrEqual(0);
      expect(iRemove).toBeGreaterThan(iPause);
      expect(iLoad).toBeGreaterThan(iRemove);
    }

    // State must be reset: playing the SAME track again must go through the
    // full setup path (which activates the other element), not the
    // early-return resume path.
    await ctrl.playTrack(trackA);
    expect(audioEl(0).play).toHaveBeenCalledTimes(1);
  });

  it("B3 variant: release() cancels a pending retry timer", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const ctrl = AudioControllerClass.getInstance();
    await ctrl.playTrack(trackA);
    const audio = audioEl(1);

    fireError(audio);
    ctrl.release();
    await vi.advanceTimersByTimeAsync(2000);

    expect(clearSpy).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).not.toContain("retry=");
  });

  describe("AudioController event-listener lifecycle", () => {
    it("registers exactly 11 native listeners, one per event type, on each element", () => {
      AudioControllerClass.getInstance();
      const expected = [
        "timeupdate",
        "durationchange",
        "waiting",
        "playing",
        "pause",
        "ended",
        "error",
        "progress",
        "seeked",
        "loadeddata",
        "suspend",
      ];
      expect(audioElements).toHaveLength(2);
      for (const el of audioElements) {
        expect(Object.keys(el._listeners).sort()).toEqual([...expected].sort());
        for (const type of expected) {
          expect(el._listeners[type]).toHaveLength(1);
        }
      }
    });

    it("release() keeps native listeners attached — error events still reach consumers after a release + replay cycle (logout -> re-login reuse flow)", async () => {
      const ctrl = AudioControllerClass.getInstance();
      const errorHandler = vi.fn();
      ctrl.on("error", errorHandler);

      await ctrl.playTrack(trackA);
      ctrl.release();

      // Re-login: same singleton, same elements. release() reset the track
      // state, so playTrack goes through the full setup path again and the
      // OTHER element becomes active.
      await ctrl.playTrack(trackA);
      const active = audioElements.find((el) =>
        el.src.includes("drive-stream"),
      );
      expect(active).toBeDefined();
      if (active) {
        // The error listener must still be attached on the active element
        // after release(). If someone later "fixes" release() by detaching the
        // native listeners, this emit never fires and the test fails.
        fireError(active);
        expect(errorHandler).toHaveBeenCalledTimes(1);
        expect(errorHandler).toHaveBeenCalledWith(
          expect.objectContaining({ code: "network_interrupted" }),
        );
      }
    });

    it("repeated playTrack cycles never accumulate duplicate native listeners on an element", async () => {
      const ctrl = AudioControllerClass.getInstance();
      await ctrl.playTrack(trackA);
      await ctrl.playTrack(trackB);
      await ctrl.playTrack(trackA);
      for (const el of audioElements) {
        for (const type of Object.keys(el._listeners)) {
          expect(el._listeners[type]).toHaveLength(1);
        }
      }
    });
  });

  describe("AudioController buffer progress events", () => {
    beforeEach(() => {
      // progress-throttle assertions compare real wall-clock deltas between
      // synchronous event dispatches, so real timers keep them deterministic.
      vi.useRealTimers();
    });

    it("emits progress when the ACTIVE element fires a native progress event", async () => {
      const ctrl = AudioControllerClass.getInstance();
      const progressHandler = vi.fn();
      ctrl.on("progress", progressHandler);

      await ctrl.playTrack(trackA);
      const active = audioEl(1); // playTrack flips activeIndex 0 -> 1
      fireProgress(active);
      expect(progressHandler).toHaveBeenCalledTimes(1);
    });

    it("ignores native progress events from the INACTIVE element", async () => {
      const ctrl = AudioControllerClass.getInstance();
      const progressHandler = vi.fn();
      ctrl.on("progress", progressHandler);

      await ctrl.playTrack(trackA);
      const inactive = audioEl(0);
      fireProgress(inactive);
      expect(progressHandler).not.toHaveBeenCalled();
    });

    it("throttles progress emission (max ~5/s) but always emits the first event", async () => {
      const ctrl = AudioControllerClass.getInstance();
      const progressHandler = vi.fn();
      ctrl.on("progress", progressHandler);

      await ctrl.playTrack(trackA);
      const active = audioEl(1);

      fireProgress(active); // first event -> always emitted (even at t=0)
      fireProgress(active); // inside throttle window -> suppressed
      expect(progressHandler).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 250));
      fireProgress(active); // outside throttle window -> emitted
      expect(progressHandler).toHaveBeenCalledTimes(2);
    });

    it("re-emits progress when seeked/loadeddata/suspend/durationchange fire on the ACTIVE element (buffered may have changed while the last progress event read it empty)", async () => {
      const ctrl = AudioControllerClass.getInstance();
      const progressHandler = vi.fn();
      ctrl.on("progress", progressHandler);

      await ctrl.playTrack(trackA);
      const active = audioEl(1);

      fireNative(active, "seeked");
      fireNative(active, "loadeddata");
      fireNative(active, "suspend");
      fireNative(active, "durationchange");

      expect(progressHandler).toHaveBeenCalledTimes(4);
    });

    it("does not re-emit progress from seeked/loadeddata/suspend/durationchange on the INACTIVE element", async () => {
      const ctrl = AudioControllerClass.getInstance();
      const progressHandler = vi.fn();
      ctrl.on("progress", progressHandler);

      await ctrl.playTrack(trackA);
      const inactive = audioEl(0);

      fireNative(inactive, "seeked");
      fireNative(inactive, "loadeddata");
      fireNative(inactive, "suspend");
      fireNative(inactive, "durationchange");

      expect(progressHandler).not.toHaveBeenCalled();
    });
  });
});
