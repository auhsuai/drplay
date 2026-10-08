import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  pictureDir: vi.fn(),
  join: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("@tauri-apps/api/path", () => ({
  pictureDir: tauriMocks.pictureDir,
  join: tauriMocks.join,
}));

import {
  addAudioDelay,
  addSubDelay,
  addSubtitleFile,
  addVideoZoom,
  aspectCycleValue,
  buildScreenshotName,
  clearAbLoop,
  cropRectFor,
  deinterlaceCycle,
  getAbLoop,
  getAudioDevice,
  getAudioDevices,
  getAspectOverride,
  getCrop,
  getCurrentChapter,
  getDeinterlace,
  getMediaInfo,
  getSecondarySubtitleId,
  getSpeed,
  getSubDelay,
  getSubtitleVisibility,
  getTrackList,
  getVideoDimensions,
  nextTrackId,
  resetSubDelay,
  resetVideoView,
  setAbLoopA,
  setAbLoopB,
  setAspectOverride,
  setAudioDevice,
  setAudioTrack,
  setChapter,
  setCrop,
  setDeinterlace,
  setSecondarySubtitle,
  setSpeed,
  setSubtitleTrack,
  setVideoTrack,
  speedStep,
  takeScreenshot,
  toggleSubtitleVisibility,
  type MpvTrack,
} from "./mpvControl";

function mockPropertyGet(props: Record<string, unknown>): void {
  tauriMocks.invoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "mpv_get_property") {
      const prop = (args as { prop?: string } | undefined)?.prop ?? "";
      return Promise.resolve(prop in props ? props[prop] : null);
    }
    return Promise.resolve(undefined);
  });
}

function lastMpvCommand(): unknown {
  const calls = tauriMocks.invoke.mock.calls as unknown as Array<
    [string, { cmd?: unknown }]
  >;
  const mpvCalls = calls.filter((call) => call[0] === "mpv_command");
  return mpvCalls[mpvCalls.length - 1]?.[1]?.cmd;
}

function audioTrack(overrides: Partial<MpvTrack> = {}): MpvTrack {
  return {
    id: 1,
    type: "audio",
    isDefault: true,
    forced: false,
    selected: false,
    external: false,
    ...overrides,
  };
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.pictureDir.mockReset();
  tauriMocks.join.mockReset();
  mockPropertyGet({});
});

describe("mpvControl — property/command facade", () => {
  it("setAudioTrack accepts an id and 'no'", async () => {
    await setAudioTrack(5);
    expect(lastMpvCommand()).toEqual(["set_property", "aid", "5"]);
    await setAudioTrack("no");
    expect(lastMpvCommand()).toEqual(["set_property", "aid", "no"]);
  });

  it("setSubtitleTrack / setVideoTrack write sid / vid", async () => {
    await setSubtitleTrack(2);
    expect(lastMpvCommand()).toEqual(["set_property", "sid", "2"]);
    await setSubtitleTrack("no");
    expect(lastMpvCommand()).toEqual(["set_property", "sid", "no"]);
    await setVideoTrack(1);
    expect(lastMpvCommand()).toEqual(["set_property", "vid", "1"]);
    await setVideoTrack("no");
    expect(lastMpvCommand()).toEqual(["set_property", "vid", "no"]);
  });

  it("addSubtitleFile selects the added subtitle file", async () => {
    await addSubtitleFile("C:\\subs\\movie.srt");
    expect(lastMpvCommand()).toEqual([
      "sub-add",
      "C:\\subs\\movie.srt",
      "select",
    ]);
  });

  it("setSecondarySubtitle accepts id | 'no' | 'auto'", async () => {
    await setSecondarySubtitle("auto");
    expect(lastMpvCommand()).toEqual(["set_property", "secondary-sid", "auto"]);
  });

  it("toggleSubtitleVisibility flips the current state", async () => {
    mockPropertyGet({ "sub-visibility": true });
    await toggleSubtitleVisibility();
    expect(lastMpvCommand()).toEqual(["set_property", "sub-visibility", "no"]);

    mockPropertyGet({ "sub-visibility": false });
    await toggleSubtitleVisibility();
    expect(lastMpvCommand()).toEqual(["set_property", "sub-visibility", "yes"]);
  });

  it("setAudioDevice / setChapter / setSpeed write their properties", async () => {
    await setAudioDevice("wasapi/{abc}");
    expect(lastMpvCommand()).toEqual([
      "set_property",
      "audio-device",
      "wasapi/{abc}",
    ]);
    await setChapter(3);
    expect(lastMpvCommand()).toEqual(["set_property", "chapter", "3"]);
    await setSpeed(1.25);
    expect(lastMpvCommand()).toEqual(["set_property", "speed", "1.25"]);
  });

  it("setAspectOverride maps auto/no to mpv sentinel values", async () => {
    await setAspectOverride("auto");
    expect(lastMpvCommand()).toEqual([
      "set_property",
      "video-aspect-override",
      "-2",
    ]);
    await setAspectOverride("no");
    expect(lastMpvCommand()).toEqual([
      "set_property",
      "video-aspect-override",
      "-1",
    ]);
    await setAspectOverride(1.5);
    expect(lastMpvCommand()).toEqual([
      "set_property",
      "video-aspect-override",
      "1.5",
    ]);
  });

  it("resetVideoView zeroes zoom and pan; addVideoZoom uses the add command", async () => {
    await resetVideoView();
    const calls = tauriMocks.invoke.mock.calls as unknown as Array<
      [string, { cmd?: unknown }]
    >;
    const cmds = calls
      .filter((call) => call[0] === "mpv_command")
      .map((call) => call[1].cmd);
    expect(cmds).toEqual([
      ["set_property", "video-zoom", "0"],
      ["set_property", "video-pan-x", "0"],
      ["set_property", "video-pan-y", "0"],
    ]);

    await addVideoZoom(0.1);
    expect(lastMpvCommand()).toEqual(["add", "video-zoom", "0.1"]);
  });

  it("setCrop / setDeinterlace write their properties", async () => {
    await setCrop("1440x1080+240+0");
    expect(lastMpvCommand()).toEqual([
      "set_property",
      "video-crop",
      "1440x1080+240+0",
    ]);
    await setDeinterlace("auto");
    expect(lastMpvCommand()).toEqual(["set_property", "deinterlace", "auto"]);
  });

  it("addSubDelay / resetSubDelay / addAudioDelay use the add + reset contract", async () => {
    await addSubDelay(-0.05);
    expect(lastMpvCommand()).toEqual(["add", "sub-delay", "-0.05"]);
    await resetSubDelay();
    expect(lastMpvCommand()).toEqual(["set_property", "sub-delay", "0"]);
    await addAudioDelay(0.05);
    expect(lastMpvCommand()).toEqual(["add", "audio-delay", "0.05"]);
  });

  it("ab-loop setters map null to 'no'; clearAbLoop clears both points", async () => {
    await setAbLoopA(12.5);
    expect(lastMpvCommand()).toEqual(["set_property", "ab-loop-a", "12.5"]);
    await setAbLoopB(null);
    expect(lastMpvCommand()).toEqual(["set_property", "ab-loop-b", "no"]);
    await clearAbLoop();
    const calls = tauriMocks.invoke.mock.calls as unknown as Array<
      [string, { cmd?: unknown }]
    >;
    const cmds = calls
      .filter((call) => call[0] === "mpv_command")
      .map((call) => call[1].cmd);
    expect(cmds.slice(-2)).toEqual([
      ["set_property", "ab-loop-a", "no"],
      ["set_property", "ab-loop-b", "no"],
    ]);
  });

  it("getAbLoop parses 'no' as null", async () => {
    mockPropertyGet({ "ab-loop-a": 5, "ab-loop-b": "no" });
    expect(await getAbLoop()).toEqual({ a: 5, b: null });
    mockPropertyGet({ "ab-loop-a": null, "ab-loop-b": 9 });
    expect(await getAbLoop()).toEqual({ a: null, b: 9 });
  });

  it("takeScreenshot writes into pictureDir with a timestamped name and returns the path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
    tauriMocks.pictureDir.mockResolvedValue("C:\\Pictures");
    tauriMocks.join.mockImplementation(
      (dir: string, name: string) => `${dir}\\${name}`,
    );
    try {
      const path = await takeScreenshot();
      expect(path).toBe("C:\\Pictures\\DrPlay-20260102-030405.png");
      expect(lastMpvCommand()).toEqual([
        "screenshot-to-file",
        "C:\\Pictures\\DrPlay-20260102-030405.png",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("buildScreenshotName zero-pads the timestamp", () => {
    expect(buildScreenshotName(new Date(2026, 11, 31, 23, 59, 9))).toBe(
      "DrPlay-20261231-235909.png",
    );
  });

  it("getters read their properties and narrow values", async () => {
    mockPropertyGet({
      speed: 1.5,
      "video-aspect-override": -2,
      "video-zoom": 0.1,
      "video-crop": "1440x1080+240+0",
      deinterlace: "auto",
      "sub-delay": -0.05,
      "audio-device": "auto",
      chapter: 2,
    });
    expect(await getSpeed()).toBe(1.5);
    expect(await getAspectOverride()).toBe(-2);
    expect(await getCrop()).toBe("1440x1080+240+0");
    expect(await getDeinterlace()).toBe("auto");
    expect(await getSubDelay()).toBe(-0.05);
    expect(await getAudioDevice()).toBe("auto");
    expect(await getCurrentChapter()).toBe(2);
  });

  it("getVideoDimensions reads width + height and reports a missing one as 0", async () => {
    mockPropertyGet({ width: 1920, height: 1080 });
    expect(await getVideoDimensions()).toEqual({ width: 1920, height: 1080 });

    mockPropertyGet({ width: 1920 });
    expect(await getVideoDimensions()).toEqual({ width: 1920, height: 0 });

    mockPropertyGet({});
    expect(await getVideoDimensions()).toEqual({ width: 0, height: 0 });
  });

  it("getSubtitleVisibility reads sub-visibility, defaulting to false", async () => {
    mockPropertyGet({ "sub-visibility": true });
    expect(await getSubtitleVisibility()).toBe(true);

    mockPropertyGet({ "sub-visibility": false });
    expect(await getSubtitleVisibility()).toBe(false);

    mockPropertyGet({});
    expect(await getSubtitleVisibility()).toBe(false);
  });

  it("getSecondarySubtitleId reads secondary-sid; unset ('no') is null", async () => {
    mockPropertyGet({ "secondary-sid": 3 });
    expect(await getSecondarySubtitleId()).toBe(3);

    mockPropertyGet({ "secondary-sid": "no" });
    expect(await getSecondarySubtitleId()).toBe(null);

    mockPropertyGet({});
    expect(await getSecondarySubtitleId()).toBe(null);
  });

  it("getTrackList parses track entries and skips malformed ones", async () => {
    mockPropertyGet({
      "track-list": [
        {
          id: 1,
          type: "audio",
          title: "English",
          lang: "eng",
          codec: "aac",
          "demux-channel-count": 2,
          default: true,
          forced: false,
          selected: true,
          external: false,
        },
        { id: "bad", type: "audio" },
        { id: 2, type: "sub", selected: false },
      ],
    });
    const tracks = await getTrackList();
    expect(tracks).toEqual([
      {
        id: 1,
        type: "audio",
        title: "English",
        lang: "eng",
        codec: "aac",
        channels: 2,
        isDefault: true,
        forced: false,
        selected: true,
        external: false,
      },
      {
        id: 2,
        type: "sub",
        isDefault: false,
        forced: false,
        selected: false,
        external: false,
      },
    ]);
  });

  it("getAudioDevices parses the device list", async () => {
    mockPropertyGet({
      "audio-device-list": [
        { name: "auto", description: "Automatic" },
        { description: "missing name" },
      ],
    });
    expect(await getAudioDevices()).toEqual([
      { name: "auto", description: "Automatic" },
    ]);
  });

  it("getMediaInfo reads one snapshot with split track lists and selected ids", async () => {
    mockPropertyGet({
      filename: "/media/movie.mkv",
      "media-title": "Movie",
      duration: 120.5,
      "video-codec": "h264",
      width: 1920,
      height: 1080,
      "container-fps": 23.976,
      "video-params/pixelformat": "yuv420p",
      "audio-codec-name": "aac",
      "hwdec-current": "d3d11va",
      "current-vo": "gpu-next",
      "video-bitrate": 5000000,
      "audio-bitrate": 128000,
      "track-list": [
        { id: 1, type: "audio", selected: true, default: true },
        { id: 2, type: "audio", selected: false, default: false },
        {
          id: 3,
          type: "sub",
          selected: false,
          default: false,
          forced: true,
          external: true,
        },
        { id: 9, type: "video", selected: true, default: true },
      ],
    });
    const info = await getMediaInfo();
    expect(info).toEqual({
      path: "/media/movie.mkv",
      title: "Movie",
      duration: 120.5,
      videoCodec: "h264",
      width: 1920,
      height: 1080,
      fps: 23.976,
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      hwdec: "d3d11va",
      videoOutput: "gpu-next",
      videoBitrate: 5000000,
      audioBitrate: 128000,
      audioTracks: [
        audioTrack({ id: 1, selected: true }),
        audioTrack({ id: 2, isDefault: false }),
      ],
      subtitleTracks: [
        {
          id: 3,
          type: "sub",
          isDefault: false,
          forced: true,
          selected: false,
          external: true,
        },
      ],
      audioTrackId: 1,
      subtitleTrackId: null,
    });
  });

  it("getters throw a wrapped error when the invoke rejects", async () => {
    tauriMocks.invoke.mockRejectedValue(new Error("ipc down"));
    await expect(getSpeed()).rejects.toThrow(/get speed.*ipc down/);
    await expect(getVideoDimensions()).rejects.toThrow(/get width.*ipc down/);
    await expect(getSubtitleVisibility()).rejects.toThrow(
      /get sub-visibility.*ipc down/,
    );
    await expect(getSecondarySubtitleId()).rejects.toThrow(
      /get secondary-sid.*ipc down/,
    );
  });

  it("actions throw a wrapped error when the invoke rejects", async () => {
    tauriMocks.invoke.mockRejectedValue("boom");
    await expect(setAudioTrack(1)).rejects.toThrow(/set_property.*boom/);
  });
});

describe("mpvControl — pure helpers", () => {
  it("nextTrackId wraps around, no-ops for <=1 track, and handles missing/current null", () => {
    const tracks = [
      audioTrack({ id: 1 }),
      audioTrack({ id: 2 }),
      audioTrack({ id: 3 }),
    ];
    expect(nextTrackId(tracks, 3, 1)).toBe(1);
    expect(nextTrackId(tracks, 3, -1)).toBe(2);
    expect(nextTrackId(tracks, 1, -1)).toBe(3);
    expect(nextTrackId(tracks, null, 1)).toBe(1);
    expect(nextTrackId(tracks, null, -1)).toBe(3);
    expect(nextTrackId(tracks, 99, 1)).toBe(1);
    expect(nextTrackId(tracks, 99, -1)).toBe(3);
    expect(nextTrackId([audioTrack({ id: 1 })], 1, 1)).toBeNull();
    expect(nextTrackId([], null, 1)).toBeNull();
  });

  it("aspectCycleValue cycles the fixed preset ring and tolerates mpv rounding", () => {
    expect(aspectCycleValue(-2)).toBeCloseTo(16 / 9);
    expect(aspectCycleValue(16 / 9)).toBeCloseTo(4 / 3);
    expect(aspectCycleValue(1.7777778)).toBeCloseTo(4 / 3);
    expect(aspectCycleValue(4 / 3)).toBeCloseTo(21 / 9);
    expect(aspectCycleValue(21 / 9)).toBe(1);
    expect(aspectCycleValue(1)).toBe(-2);
    expect(aspectCycleValue(1.85)).toBe(-2);
  });

  it("deinterlaceCycle walks no -> auto -> yes -> no", () => {
    expect(deinterlaceCycle("no")).toBe("auto");
    expect(deinterlaceCycle("auto")).toBe("yes");
    expect(deinterlaceCycle("yes")).toBe("no");
    expect(deinterlaceCycle("garbage")).toBe("no");
  });

  it("cropRectFor centers the crop and returns the full rect when ratio matches", () => {
    expect(cropRectFor(1920, 1080, 16 / 9)).toBe("1920x1080+0+0");
    expect(cropRectFor(1920, 1080, 4 / 3)).toBe("1440x1080+240+0");
    expect(cropRectFor(1000, 2000, 1)).toBe("1000x1000+0+500");
  });

  it("speedStep walks the preset ladder and clamps at both ends", () => {
    expect(speedStep(1, 1)).toBe(1.25);
    expect(speedStep(1, -1)).toBe(0.75);
    expect(speedStep(0.75, -1)).toBe(0.5);
    expect(speedStep(0.5, -1)).toBe(0.5);
    expect(speedStep(2, 1)).toBe(2);
    expect(speedStep(0.9, 1)).toBe(1.25);
  });
});
