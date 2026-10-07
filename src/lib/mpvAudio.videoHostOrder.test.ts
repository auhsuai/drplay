import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";

/**
 * The `--wid` ordering contract (Slice 2): mpv reads `--wid` ONCE, at spawn, so
 * `video_host_acquire` must be awaited BEFORE the first `mpv_spawn`. Asserting
 * ORDER across two invokes (not just that both happened) is the whole point —
 * a "both were called" test would pass on the exact bug this guards.
 */
const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriMocks.listen }));
vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

const HOST_HWND = 918992;

const audioTrack: Track = {
  id: "A",
  title: "Song.mp3",
  artist: "Artist",
  streamUrl: "/drive-stream/A",
};
const videoTrack: Track = {
  id: "V",
  title: "Movie",
  artist: "",
  streamUrl: "/drive-stream/V",
  originalName: "Movie.mkv",
};

function commandNames(): string[] {
  return (tauriMocks.invoke.mock.calls as unknown as Array<[string]>).map(
    (call) => call[0],
  );
}

function mockInvoke(acquire: () => Promise<unknown>): void {
  tauriMocks.invoke.mockImplementation((command: string) => {
    if (command === "stream_proxy_start") return Promise.resolve(51234);
    if (command === "video_host_acquire") return acquire();
    return Promise.resolve(undefined);
  });
}

/** The host acquire is memoized per session (one host, one handle), so every
 *  case below resets the module graph to observe its own acquire. */
beforeEach(() => {
  vi.resetModules();
  tauriMocks.invoke.mockReset();
  tauriMocks.listen.mockClear();
  mockInvoke(() => Promise.resolve(HOST_HWND));
});

describe("acquire-before-spawn ordering contract", () => {
  it("the first play awaits video_host_acquire BEFORE mpv_spawn", async () => {
    const { MpvAudioController } = await import("./mpvAudio");
    await new MpvAudioController().playTrack(audioTrack);

    const names = commandNames();
    expect(names.indexOf("video_host_acquire")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("video_host_acquire")).toBeLessThan(
      names.indexOf("mpv_spawn"),
    );
  });

  it("a VIDEO track acquires first too — --wid is read at spawn, not at loadfile", async () => {
    const { MpvAudioController } = await import("./mpvAudio");
    await new MpvAudioController().playTrack(videoTrack);

    const names = commandNames();
    expect(names.indexOf("video_host_acquire")).toBeLessThan(
      names.indexOf("mpv_spawn"),
    );
  });

  it("a session that never plays video still acquires (app-startup path)", async () => {
    vi.resetModules();
    const { ensureVideoHostAcquired } = await import("./videoHost");

    expect(await ensureVideoHostAcquired()).toBe(HOST_HWND);
    expect(commandNames()).toEqual(["video_host_acquire"]);
  });

  it("a failed acquire degrades to mpv's own window instead of failing playback", async () => {
    mockInvoke(() => Promise.reject(new Error("no window")));
    const { MpvAudioController } = await import("./mpvAudio");

    await expect(
      new MpvAudioController().playTrack(videoTrack),
    ).resolves.toBeUndefined();

    const names = commandNames();
    expect(names).toContain("video_host_acquire");
    expect(names).toContain("mpv_spawn");
  });
});
