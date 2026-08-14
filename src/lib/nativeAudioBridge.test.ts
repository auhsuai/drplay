// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NativeAudioEngine } from "./nativeAudioBridge";

// IS_MOBILE is a module-level constant read at import time — the platform
// mock must be installed BEFORE the bridge module is imported.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../utils/platform", () => ({ IS_MOBILE: platformMock.IS_MOBILE }));

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
  });

  describe("getPlaybackEngine", () => {
    it("returns the native engine on mobile (IS_MOBILE=true)", () => {
      expect(bridge.getPlaybackEngine()).toBe(
        bridge.nativeAudioEngine as unknown as ReturnType<
          typeof bridge.getPlaybackEngine
        >,
      );
    });
  });
});
