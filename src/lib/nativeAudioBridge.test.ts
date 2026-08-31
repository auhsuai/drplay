// @vitest-environment jsdom
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  expectTypeOf,
} from "vitest";
import type { NativeAudioEngine, PlaybackEngine } from "./nativeAudioBridge";

// IS_MOBILE is a module-level constant read at import time — the platform
// mock must be installed BEFORE the bridge module is imported. A live getter
// (instead of a value snapshot) lets tests flip the branch at call time;
// vitest caches the vi.mock factory result per file, so a snapshot would
// freeze the value from the very first import.
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

let bridge: typeof import("./nativeAudioBridge");
let engine: NativeAudioEngine;

beforeEach(async () => {
  invokeMock.mockReset();
  addPluginListenerMock.mockReset();
  setStateMock.mockReset();
  addPluginListenerMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue({});
  // Engine behavior only exists on mobile — run the whole suite as mobile.
  platformMock.IS_MOBILE = true;
  // Fresh module instance per test — the engine is a singleton by design.
  vi.resetModules();
  bridge = await import("./nativeAudioBridge");
  engine = bridge.nativeAudioEngine;
});

describe("nativeAudioBridge", () => {
  describe("buildDriveStreamUrl", () => {
    it("builds the Google Drive alt=media URL with the file id", () => {
      expect(bridge.buildDriveStreamUrl("abc123")).toBe(
        "https://www.googleapis.com/drive/v3/files/abc123?alt=media",
      );
    });
  });

  describe("initOnce", () => {
    it("invokes initialize and registers the state listener exactly once", async () => {
      await engine.initOnce();
      await engine.initOnce();

      expect(invokeMock).toHaveBeenCalledWith("plugin:native-audio|initialize");
      expect(addPluginListenerMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("playTrack", () => {
    it("calls set_source with the drive URL and Authorization header, then play", async () => {
      engine.setToken("tok-1");
      await engine.playTrack({
        id: "file-1",
        title: "Song",
        artist: "",
        streamUrl: "",
      });

      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:native-audio|set_source",
        expect.objectContaining({
          src: "https://www.googleapis.com/drive/v3/files/file-1?alt=media",
          headers: { Authorization: "Bearer tok-1" },
        }),
      );
      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:native-audio|play",
        undefined,
      );
    });

    it("does not send an Authorization header when no token is set", async () => {
      await engine.playTrack({
        id: "f",
        title: "t",
        artist: "",
        streamUrl: "",
      });

      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:native-audio|set_source",
        expect.objectContaining({ headers: undefined }),
      );
    });

    it("replays the SAME track without calling set_source again", async () => {
      engine.setToken("tok-1");
      await engine.playTrack({
        id: "f",
        title: "t",
        artist: "",
        streamUrl: "",
      });
      invokeMock.mockClear();

      await engine.playTrack({
        id: "f",
        title: "t",
        artist: "",
        streamUrl: "",
      });

      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:native-audio|play",
        undefined,
      );
      expect(invokeMock).not.toHaveBeenCalledWith(
        "plugin:native-audio|set_source",
        expect.anything(),
      );
    });

    it("seeks before play when startTime is provided", async () => {
      await engine.playTrack(
        { id: "f", title: "t", artist: "", streamUrl: "" },
        42,
      );

      expect(invokeMock).toHaveBeenCalledWith("plugin:native-audio|seek_to", {
        position: 42,
      });
    });

    // CF-2 regression: two overlapping playTrack() chains used to interleave
    // their set_source/seek_to/play commands — the stale chain's seek landed
    // on the newer source (mis-seek / wrong track playing).
    it("never lets a superseded playTrack chain seek/play over the newer source", async () => {
      engine.setToken("tok-1");
      const commands: string[] = [];
      invokeMock.mockImplementation(
        (cmd: string, payload?: { src?: string }) => {
          commands.push(
            cmd === "plugin:native-audio|set_source"
              ? `set_source:${String(payload?.src)}`
              : cmd,
          );
          // Tiered delays force the interleaving: A's set_source resolves long
          // after B's whole chain has completed.
          const isSlowSourceA =
            cmd === "plugin:native-audio|set_source" &&
            payload?.src?.includes("track-A") === true;
          return new Promise((resolve) => {
            setTimeout(
              () => {
                resolve({});
              },
              isSlowSourceA ? 40 : 0,
            );
          });
        },
      );

      await Promise.allSettled([
        engine.playTrack(
          { id: "track-A", title: "A", artist: "", streamUrl: "" },
          120,
        ),
        engine.playTrack({
          id: "track-B",
          title: "B",
          artist: "",
          streamUrl: "",
        }),
      ]);

      let lastSourceIdx = -1;
      for (let i = commands.length - 1; i >= 0; i--) {
        if (commands[i]?.startsWith("set_source")) {
          lastSourceIdx = i;
          break;
        }
      }
      expect(lastSourceIdx).toBeGreaterThan(-1);
      expect(commands[lastSourceIdx]).toContain("track-B");

      // The stale chain must never fire seek_to(restoreA) onto source B.
      const seekCalls = invokeMock.mock.calls.filter(
        ([cmd]) => cmd === "plugin:native-audio|seek_to",
      );
      expect(seekCalls).toEqual([]);

      // After the winning set_source(track-B), only B's own transport ops
      // may follow (B has no startTime → just play).
      expect(commands.slice(lastSourceIdx)).toEqual([
        expect.stringContaining("set_source"),
        "plugin:native-audio|play",
      ]);
    });
  });

  describe("release", () => {
    it("invalidates a pending play chain — nothing loads or plays after release", async () => {
      engine.setToken("tok-1");
      const commands: string[] = [];
      let resolveSlowSource: ((v: unknown) => void) | undefined;
      invokeMock.mockImplementation(
        (cmd: string, payload?: { src?: string }) => {
          commands.push(cmd);
          if (
            cmd === "plugin:native-audio|set_source" &&
            payload?.src?.includes("track-A") === true
          ) {
            // Slow source: hold the chain suspended on its set_source await
            // until the test releases it.
            return new Promise((resolve) => {
              resolveSlowSource = resolve;
            });
          }
          return Promise.resolve({});
        },
      );

      const turn = engine.playTrack(
        { id: "track-A", title: "A", artist: "", streamUrl: "" },
        30,
      );
      // Wait until the chain has actually dispatched set_source(track-A) and
      // is suspended on it — only then is the release/resolve ordering sound.
      await vi.waitFor(() => {
        expect(commands).toContainEqual(
          expect.stringContaining("plugin:native-audio|set_source"),
        );
      });

      const releaseMarker = commands.length;
      await engine.release();

      resolveSlowSource?.({});
      await turn;

      // Only release's own pause may follow the release marker — the resumed
      // chain must NOT fire seek_to(30)/play onto the released player.
      expect(commands.slice(releaseMarker)).toEqual([
        "plugin:native-audio|pause",
      ]);
    });
  });

  describe("state mapping", () => {
    const listener = () =>
      addPluginListenerMock.mock.calls[0]?.[2] as (s: unknown) => void;

    it("maps an ended state to an 'ended' event", async () => {
      await engine.initOnce();
      const seen: string[] = [];
      engine.on("ended", () => seen.push("ended"));

      listener()({
        status: "ended",
        currentTime: 10,
        duration: 10,
        isPlaying: false,
        buffering: false,
        rate: 1,
      });

      expect(seen).toEqual(["ended"]);
    });

    it("maps an error state to format_error + ended (auto-advance parity)", async () => {
      await engine.initOnce();
      const seen: Array<{ code: string }> = [];
      engine.on("error", (e) => seen.push(e));

      listener()({
        status: "error",
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        buffering: false,
        rate: 1,
        error: "boom",
      });

      expect(seen[0]?.code).toBe("format_error");
    });

    it("appends the moov-at-end hint to the error message when the current track is streamUnplayable", async () => {
      await engine.initOnce();
      await engine.playTrack({
        id: "m4a-1",
        title: "t",
        artist: "",
        streamUrl: "",
        streamUnplayable: true,
      });
      const seen: Array<{ message: string; code: string }> = [];
      engine.on("error", (e) => seen.push(e));

      listener()({
        status: "error",
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        buffering: false,
        rate: 1,
        error: "boom",
      });

      // The hint must not change the error code (format_error) or the
      // auto-advance path (ended) — it only clarifies the raw message.
      expect(seen[0]?.message).toContain("m4a moov-at-end");
      expect(seen[0]?.code).toBe("format_error");
    });

    it("leaves the error message untouched when the current track is not streamUnplayable", async () => {
      await engine.initOnce();
      await engine.playTrack({
        id: "mp3-1",
        title: "t",
        artist: "",
        streamUrl: "",
      });
      const seen: Array<{ message: string }> = [];
      engine.on("error", (e) => seen.push(e));

      listener()({
        status: "error",
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        buffering: false,
        rate: 1,
        error: "boom",
      });

      expect(seen[0]?.message).toBe("boom");
    });

    it("maps playing state to a play event and store sync", async () => {
      await engine.initOnce();
      const seen: string[] = [];
      engine.on("play", () => seen.push("play"));

      listener()({
        status: "playing",
        currentTime: 1,
        duration: 100,
        isPlaying: true,
        buffering: false,
        rate: 1,
      });

      expect(seen).toEqual(["play"]);
      expect(setStateMock).toHaveBeenCalledWith(true);
    });

    it("maps pause to a pause event and store sync", async () => {
      await engine.initOnce();
      const seen: string[] = [];
      engine.on("pause", () => seen.push("pause"));

      listener()({
        status: "playing",
        currentTime: 1,
        duration: 100,
        isPlaying: true,
        buffering: false,
        rate: 1,
      });
      listener()({
        status: "idle",
        currentTime: 1,
        duration: 100,
        isPlaying: false,
        buffering: false,
        rate: 1,
      });

      expect(seen).toEqual(["pause"]);
      expect(setStateMock).toHaveBeenCalledWith(false);
    });

    it("emits throttled timeupdate events with the latest position", async () => {
      await engine.initOnce();
      const seen: Array<{ currentTime: number }> = [];
      engine.on("timeupdate", (e) => seen.push(e));

      for (let i = 1; i <= 3; i++) {
        listener()({
          status: "playing",
          currentTime: i,
          duration: 100,
          isPlaying: true,
          buffering: false,
          rate: 1,
        });
      }

      // 3 rapid ticks coalesce into 1 throttled timeupdate (200ms window);
      // the trailing in-window tick may be dropped, so only the emit count
      // (and a valid position) is asserted — parity with desktop's 200ms
      // throttle semantics.
      expect(seen.length).toBe(1);
      expect(seen[0]?.currentTime).toBeGreaterThan(0);
    });

    it("does not emit play/pause for a not-loaded state change", async () => {
      await engine.initOnce();
      const seen: string[] = [];
      engine.on("play", () => seen.push("play"));
      engine.on("pause", () => seen.push("pause"));

      listener()({
        status: "idle",
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        buffering: false,
        rate: 1,
      });

      expect(seen).toEqual([]);
    });

    // Root cause regression: Kotlin's emitState() pushes an idle snapshot
    // {0,0} when PlayerBar's play/pause sync effect calls pause() right
    // after a cold-start session restore. AudioController never emits a
    // timeupdate without real media state, so surfacing the idle snapshot
    // as timeupdate violates the engine contract — SeekBar applies the
    // payload unconditionally and wipes the restored duration/position
    // seed to 0:00.
    it("does not emit timeupdate for an idle snapshot (cold-start restore pause)", async () => {
      await engine.initOnce();
      // Drive the throttle clock deterministically: the spy makes the idle
      // push below pass the throttle window, proving the emit is stopped by
      // the idle guard and not by throttle.
      const nowSpy = vi.spyOn(performance, "now");
      const clock = 10_000;
      nowSpy.mockImplementation(() => clock);
      try {
        const seen: Array<{ currentTime: number; duration: number }> = [];
        engine.on("timeupdate", (e) => seen.push(e));

        listener()({
          status: "idle",
          currentTime: 0,
          duration: 0,
          isPlaying: false,
          buffering: false,
          rate: 1,
        });

        expect(seen).toEqual([]);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("still emits the pause edge for an idle snapshot after real playback (guard does not eat edges)", async () => {
      await engine.initOnce();
      const nowSpy = vi.spyOn(performance, "now");
      let clock = 10_000;
      nowSpy.mockImplementation(() => clock);
      try {
        const seen: string[] = [];
        const timeUpdates: Array<{ currentTime: number; duration: number }> =
          [];
        engine.on("pause", () => seen.push("pause"));
        engine.on("timeupdate", (e) => timeUpdates.push(e));

        // Baseline: real playback state flips wasPlaying=true and surfaces
        // exactly one throttled tick.
        listener()({
          status: "playing",
          currentTime: 5,
          duration: 100,
          isPlaying: true,
          buffering: false,
          rate: 1,
        });
        // Expire the throttle window so the idle push below is judged by the
        // idle guard alone, not by throttle.
        clock += 1_000;

        // Kotlin's pause-attached idle snapshot (the restore bug shape).
        listener()({
          status: "idle",
          currentTime: 0,
          duration: 0,
          isPlaying: false,
          buffering: false,
          rate: 1,
        });

        // The play/pause edge mapping must keep flowing unchanged...
        expect(seen).toEqual(["pause"]);
        // ...while only the real playback tick surfaces as timeupdate.
        expect(timeUpdates).toEqual([{ currentTime: 5, duration: 100 }]);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("still emits a throttled timeupdate with the exact payload for a real state", async () => {
      await engine.initOnce();
      const nowSpy = vi.spyOn(performance, "now");
      const clock = 10_000;
      nowSpy.mockImplementation(() => clock);
      try {
        const seen: Array<{ currentTime: number; duration: number }> = [];
        engine.on("timeupdate", (e) => seen.push(e));

        listener()({
          status: "playing",
          currentTime: 30,
          duration: 240,
          isPlaying: true,
          buffering: false,
          rate: 1,
        });

        expect(seen).toEqual([{ currentTime: 30, duration: 240 }]);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe("load-window play intent (track switch keeps the user's play intent)", () => {
    const listener = () =>
      addPluginListenerMock.mock.calls[0]?.[2] as (s: unknown) => void;

    // Track A READY and playing — the pre-switch baseline (wasPlaying=true,
    // store isPlaying=true from the user's intent).
    const READY_A = {
      status: "playing",
      currentTime: 5,
      duration: 100,
      isPlaying: true,
      buffering: false,
      rate: 1,
    };

    // Media3's real load shape: isPlaying stays false while buffering — it
    // only flips true at READY (the state set_source/seek/play resolve with
    // inside a JS-initiated load chain).
    const LOADING_B = {
      status: "loading",
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      buffering: true,
      rate: 1,
    };

    it("native isPlaying=false inside a JS-initiated load window must not overwrite the store's play intent", async () => {
      await engine.initOnce();
      const seen: string[] = [];
      engine.on("play", () => seen.push("play"));
      engine.on("pause", () => seen.push("pause"));
      engine.on("buffering", () => seen.push("buffering"));

      listener()(READY_A);
      setStateMock.mockClear();

      // User picks track B: the load chain resolves set_source/play with the
      // buffering shape above.
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

      // The buffering edge still flows (spinner input)…
      expect(seen).toContain("buffering");
      // …but the isPlaying=false state inside the load window is NOT a real
      // pause: it must neither emit "pause" nor write isPlaying=false over
      // the user's play intent (that overwrite killed the track-change
      // spinner).
      expect(seen).not.toContain("pause");
      expect(setStateMock).not.toHaveBeenCalledWith(false);

      // READY: the real play edge flows and re-affirms isPlaying=true.
      listener()({ ...READY_A, currentTime: 6 });
      expect(seen).toContain("play");
      expect(setStateMock).toHaveBeenCalledWith(true);
    });

    it("a REAL pause after the load window closed still syncs isPlaying=false (exactly one pause edge)", async () => {
      await engine.initOnce();
      const seen: string[] = [];
      engine.on("pause", () => seen.push("pause"));

      listener()(READY_A);
      invokeMock.mockImplementation(() => Promise.resolve(LOADING_B));
      await engine.playTrack({
        id: "track-B",
        title: "B",
        artist: "",
        streamUrl: "",
      });
      // READY for track B.
      listener()({ ...READY_A, currentTime: 6 });
      setStateMock.mockClear();

      // Focus loss / pause AFTER the chain settled — the window is closed,
      // the pause edge must sync the store as before, and the earlier load
      // window must not have leaked a fake extra pause edge.
      listener()({
        status: "idle",
        currentTime: 6,
        duration: 100,
        isPlaying: false,
        buffering: false,
        rate: 1,
      });

      expect(seen).toEqual(["pause"]);
      expect(setStateMock).toHaveBeenCalledWith(false);
    });

    it("an explicit engine.pause() mid-load closes the intent window — native pause syncs the store", async () => {
      await engine.initOnce();
      listener()(READY_A);
      setStateMock.mockClear();

      let resolveSource: ((v: unknown) => void) | undefined;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "plugin:native-audio|set_source") {
          return new Promise((resolve) => {
            resolveSource = resolve;
          });
        }
        return Promise.resolve({});
      });

      const turn = engine.playTrack({
        id: "track-B",
        title: "B",
        artist: "",
        streamUrl: "",
      });
      await vi.waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "plugin:native-audio|set_source",
          expect.anything(),
        );
      });

      // User pauses while the load chain is still suspended on set_source.
      await engine.pause();

      // pause() itself closes the window: the native isPlaying=false state is
      // a real pause and must reach the store (pause wins instantly, even
      // mid-buffer).
      listener()({
        status: "idle",
        currentTime: 5,
        duration: 0,
        isPlaying: false,
        buffering: true,
        rate: 1,
      });
      expect(setStateMock).toHaveBeenCalledWith(false);

      resolveSource?.(LOADING_B);
      await turn;
    });
  });

  describe("getPlaybackEngine", () => {
    it("returns the native engine on mobile (IS_MOBILE=true)", () => {
      expect(bridge.getPlaybackEngine()).toBe(bridge.nativeAudioEngine);
    });

    it("returns the desktop AudioController singleton on desktop (IS_MOBILE=false)", async () => {
      platformMock.IS_MOBILE = false;
      vi.resetModules();
      const desktopBridge = await import("./nativeAudioBridge");
      const { AudioController } = await import("./AudioController");
      expect(desktopBridge.getPlaybackEngine()).toBe(
        AudioController.getInstance(),
      );
    });

    it("getPlaybackEngine() returns a PlaybackEngine (compile-time contract)", () => {
      expectTypeOf(bridge.getPlaybackEngine()).toEqualTypeOf<PlaybackEngine>();
    });

    it("nativeAudioEngine satisfies the PlaybackEngine surface (compile-time contract)", () => {
      expectTypeOf(bridge.nativeAudioEngine).toExtend<PlaybackEngine>();
    });
  });

  // Long-suspend recovery: after a long device sleep the Android activity can
  // come back with a dead plugin event channel / invoke bridge while the UI
  // still renders the cached lastState — progress freezes silently. The engine
  // must probe the bridge on every visible transition (read-only get_state),
  // re-init when the probe fails, and re-sync the authoritative state.
  describe("resume health-check (long-suspend recovery)", () => {
    const GO_STATE = {
      status: "playing",
      currentTime: 42,
      duration: 100,
      isPlaying: true,
      buffering: false,
      rate: 1,
    };

    // Drain pending microtasks deterministically (no timers involved).
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

    // jsdom's document outlives vi.resetModules(), so handlers attached by an
    // earlier test's engine would keep firing in later tests — record every
    // visibilitychange registration and remove exactly those after each test.
    const addSpy = vi.spyOn(document, "addEventListener");
    afterEach(() => {
      for (const [type, handler] of addSpy.mock.calls) {
        if (type === "visibilitychange") {
          document.removeEventListener(type, handler as EventListener);
        }
      }
      addSpy.mockClear();
      vi.useRealTimers();
    });

    it("probes the read-only get_state command on a visible transition", async () => {
      await engine.initOnce();
      invokeMock.mockClear();
      invokeMock.mockResolvedValue(GO_STATE);
      dispatchVisible();
      await vi.waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "plugin:native-audio|get_state",
        );
      });
    });

    it("does not re-initialize when the bridge answers (live listener preserved)", async () => {
      await engine.initOnce();
      invokeMock.mockClear();
      addPluginListenerMock.mockClear();
      invokeMock.mockResolvedValue(GO_STATE);
      dispatchVisible();
      await vi.waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "plugin:native-audio|get_state",
        );
      });
      expect(invokeMock).not.toHaveBeenCalledWith(
        "plugin:native-audio|initialize",
      );
      expect(addPluginListenerMock).not.toHaveBeenCalled();
    });

    it("pushes the pulled state through onNativeState so the store re-syncs", async () => {
      await engine.initOnce();
      invokeMock.mockClear();
      invokeMock.mockResolvedValue(GO_STATE);
      dispatchVisible();
      await vi.waitFor(() => {
        expect(setStateMock).toHaveBeenCalledWith(true);
      });
    });

    it("re-initializes, re-subscribes once and re-syncs when the probe times out", async () => {
      await engine.initOnce();
      invokeMock.mockClear();
      addPluginListenerMock.mockClear();
      let probeCalls = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "plugin:native-audio|get_state") {
          probeCalls++;
          // First probe: wedged bridge — never answers. A later probe (the
          // re-pull after re-init) succeeds, proving the recovered bridge.
          return probeCalls === 1
            ? new Promise(() => {})
            : Promise.resolve(GO_STATE);
        }
        return Promise.resolve({});
      });

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      dispatchVisible();
      // 3s resume-probe budget (RESUME_HEALTH_CHECK_TIMEOUT_MS).
      await vi.advanceTimersByTimeAsync(3_000);
      await drainMicrotasks();

      // initPromise was reset + initOnce re-ran: initialize + listener again.
      expect(invokeMock).toHaveBeenCalledWith("plugin:native-audio|initialize");
      expect(addPluginListenerMock).toHaveBeenCalledTimes(1);
      // Authoritative state pulled after re-init → store re-synced.
      expect(setStateMock).toHaveBeenCalledWith(true);
      // The health-check listener itself must NOT be re-attached on re-init.
      expect(
        addSpy.mock.calls.filter(([type]) => type === "visibilitychange"),
      ).toHaveLength(1);
    });

    it("never probes or registers a health-check listener on desktop", async () => {
      platformMock.IS_MOBILE = false;
      vi.resetModules();
      const desktopBridge = await import("./nativeAudioBridge");
      await desktopBridge.nativeAudioEngine.initOnce();
      dispatchVisible();
      await drainMicrotasks();
      expect(invokeMock).not.toHaveBeenCalled();
      expect(
        addSpy.mock.calls.some(([type]) => type === "visibilitychange"),
      ).toBe(false);
    });
  });

  // Every invoke is bounded so one wedged command can never stall the FIFO
  // playChain (play/pause/seek queue) forever; set_source carries its own,
  // larger budget because it performs the network load + container prepare.
  describe("invoke timeouts (a wedged bridge cannot stall the chain)", () => {
    const drainMicrotasks = async () => {
      for (let i = 0; i < 25; i++) await Promise.resolve();
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects a transport command at its timeout with a classified error", async () => {
      await engine.initOnce();
      invokeMock.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      let settled = false;
      let caught: unknown;
      engine.pause().then(
        () => {
          settled = true;
        },
        (e: unknown) => {
          caught = e;
          settled = true;
        },
      );
      // 10s transport budget (TRANSPORT_INVOKE_TIMEOUT_MS).
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks();

      expect(settled).toBe(true);
      expect((caught as Error | undefined)?.name).toBe(
        "NativeInvokeTimeoutError",
      );
      expect(String(caught)).toContain("pause");
      expect(String(caught)).toContain("timeout");
    });

    it("accepts a transport command answering just under the timeout", async () => {
      await engine.initOnce();
      invokeMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            // 1ms under the 10s transport budget — must NOT be a timeout.
            setTimeout(() => {
              resolve({});
            }, 10_000 - 1);
          }),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const turn = engine.pause();
      await vi.advanceTimersByTimeAsync(10_000 - 1);
      await drainMicrotasks();
      await expect(turn).resolves.toBeUndefined();
    });

    it("gives set_source its own larger budget before rejecting", async () => {
      await engine.initOnce();
      invokeMock.mockImplementation((cmd: string) =>
        cmd === "plugin:native-audio|set_source"
          ? new Promise(() => {})
          : Promise.resolve({}),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      let settled = false;
      const turn = engine.playTrack({
        id: "A",
        title: "A",
        artist: "",
        streamUrl: "",
      });
      turn.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // At the transport budget mark (10s) the load is still inside its own
      // (30s) budget — not yet rejected.
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks();
      expect(settled).toBe(false);
      // ...and rejects at its own 30s budget (SET_SOURCE_INVOKE_TIMEOUT_MS).
      await vi.advanceTimersByTimeAsync(20_000);
      await drainMicrotasks();
      expect(settled).toBe(true);
      await expect(turn).rejects.toMatchObject({
        name: "NativeInvokeTimeoutError",
      });
    });

    it("bounds the initialize command so a wedged bridge cannot hang initOnce", async () => {
      invokeMock.mockImplementation((cmd: string) =>
        cmd === "plugin:native-audio|initialize"
          ? new Promise(() => {})
          : Promise.resolve({}),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      let settled = false;
      let caught: unknown;
      engine.initOnce().then(
        () => {
          settled = true;
        },
        (e: unknown) => {
          caught = e;
          settled = true;
        },
      );
      // initialize rides the 10s transport budget.
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks();

      expect(settled).toBe(true);
      expect((caught as Error | undefined)?.name).toBe(
        "NativeInvokeTimeoutError",
      );
    });

    it("keeps the playChain serving later commands after a wedged load times out", async () => {
      await engine.initOnce();
      let firstSourceWedged = true;
      invokeMock.mockImplementation((cmd: string) =>
        cmd === "plugin:native-audio|set_source" && firstSourceWedged
          ? new Promise(() => {})
          : Promise.resolve({}),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      let firstSettled = false;
      let firstError: unknown;
      const first = engine.playTrack({
        id: "track-A",
        title: "A",
        artist: "",
        streamUrl: "",
      });
      first.then(
        () => {
          firstSettled = true;
        },
        (e: unknown) => {
          firstError = e;
          firstSettled = true;
        },
      );
      // 30s set_source budget (SET_SOURCE_INVOKE_TIMEOUT_MS).
      await vi.advanceTimersByTimeAsync(30_000);
      await drainMicrotasks();
      expect(firstSettled).toBe(true);
      expect((firstError as Error | undefined)?.name).toBe(
        "NativeInvokeTimeoutError",
      );

      // The failed chain must not poison the queue: the next playTrack runs.
      firstSourceWedged = false;
      void engine.playTrack({
        id: "track-B",
        title: "B",
        artist: "",
        streamUrl: "",
      });
      await drainMicrotasks();
      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:native-audio|set_source",
        expect.objectContaining({
          src: "https://www.googleapis.com/drive/v3/files/track-B?alt=media",
        }),
      );
    });
  });
});
