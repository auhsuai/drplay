// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import en from "../locales/en/translation.json";
import type { Track } from "../types";
import {
  PLAYER_COMMAND_IDS,
  commandById,
  shortcutFor,
  type PlayerCommandContext,
} from "./commands";
import type { AudioController } from "../lib/AudioController";
import { ASPECT_AUTO, cropRectFor, type MpvTrack } from "../lib/mpvControl";
import { usePlayerStore } from "../store/playerStore";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

const toastMock = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));
vi.mock("../utils/simpleToast", () => toastMock);

const dialogMock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);

const errorLogMock = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("../utils/errorLog", () => errorLogMock);

const audioEngineMock = vi.hoisted(() => ({ isMuted: vi.fn(() => false) }));
vi.mock("../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioEngineMock },
}));

import {
  MENU_IDS,
  MENU_PREFIXES,
  buildContextMenuModel,
  queueMenuSlice,
  runMenuEntry,
  takeVideoMenuSnapshot,
  type VideoMenuSnapshot,
} from "./menuModel";
import type { NativeMenuEntry, NativeMenuItem } from "../lib/nativeMenu";

// ---------------------------------------------------------------------------
// i18n: the REAL i18next with the REAL en locale — a missing key would leave
// the raw key in the label, which the assertions catch.
// ---------------------------------------------------------------------------
beforeAll(async () => {
  await i18next.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
});

// ---------------------------------------------------------------------------
// Backend mock: everything funnels through the real mpvControl facade into the
// mocked Tauri invoke, so facade calls and menu labels are verified end to end.
// ---------------------------------------------------------------------------
function mockBackend(
  props: Record<string, unknown>,
  failing: string[] = [],
): void {
  tauriMocks.invoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "mpv_get_property") {
      const prop = (args as { prop?: string } | undefined)?.prop ?? "";
      if (failing.includes(prop)) {
        return Promise.reject(new Error(`get ${prop} failed`));
      }
      return Promise.resolve(prop in props ? props[prop] : null);
    }
    return Promise.resolve(undefined);
  });
}

function lastCommand(): unknown[] {
  const calls = tauriMocks.invoke.mock.calls as unknown as Array<
    [string, { cmd?: unknown[] } | undefined]
  >;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call !== undefined && call[0] === "mpv_command") {
      return call[1]?.cmd ?? [];
    }
  }
  return [];
}

function audioTrack(id: number, overrides: Partial<MpvTrack> = {}): MpvTrack {
  return {
    id,
    type: "audio",
    isDefault: false,
    forced: false,
    selected: false,
    external: false,
    ...overrides,
  };
}

function track(id: string, title: string): Track {
  return { id, title, artist: "Artist", streamUrl: `/drive-stream/${id}` };
}

function snapshot(
  overrides: Partial<VideoMenuSnapshot> = {},
): VideoMenuSnapshot {
  return {
    isPaused: false,
    isFullscreen: false,
    isMuted: false,
    tracks: [],
    audioTrackId: null,
    subtitleTrackId: null,
    subtitleVisible: false,
    secondarySubtitleId: null,
    devices: [],
    currentDevice: null,
    chapters: [],
    currentChapter: -1,
    speed: 1,
    aspect: ASPECT_AUTO,
    crop: "",
    deinterlace: "no",
    subDelay: 0,
    audioDelay: 0,
    abLoop: { a: null, b: null },
    queue: [],
    currentTrackId: null,
    playMode: "normal",
    videoWidth: null,
    videoHeight: null,
    ...overrides,
  };
}

function flatten(entries: NativeMenuEntry[]): NativeMenuItem[] {
  const flat: NativeMenuItem[] = [];
  for (const entry of entries) {
    if (entry.kind !== "item") continue;
    flat.push(entry);
    if (entry.children !== undefined) flat.push(...flatten(entry.children));
  }
  return flat;
}

function item(entries: NativeMenuEntry[], id: string): NativeMenuItem {
  const found = flatten(entries).find((entry) => entry.id === id);
  if (!found) throw new Error(`missing menu item ${id}`);
  return found;
}

function ids(entries: NativeMenuEntry[]): string[] {
  return entries.map((entry) =>
    entry.kind === "separator" ? "---" : entry.id,
  );
}

function makeCtx(): PlayerCommandContext & {
  _audio: {
    getCurrentTime: ReturnType<typeof vi.fn>;
    toggleMute: ReturnType<typeof vi.fn>;
  };
} {
  const audio = {
    getVolume: vi.fn(() => 0.5),
    setVolume: vi.fn(),
    toggleMute: vi.fn(() => true),
    isMuted: vi.fn(() => false),
    getCurrentTime: vi.fn(() => 100),
    getDuration: vi.fn(() => 240),
    seek: vi.fn(),
    pause: vi.fn(),
  };
  return {
    audio: audio as unknown as AudioController,
    isFullscreen: false,
    toggleFullscreen: vi.fn(),
    toggleQueue: vi.fn(),
    isQueueOpen: false,
    selectTrack: vi.fn(),
    togglePlay: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    togglePlayMode: vi.fn(),
    setPlayMode: vi.fn(),
    _audio: {
      getCurrentTime: audio.getCurrentTime,
      toggleMute: audio.toggleMute,
    },
  };
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  toastMock.showErrorToast.mockReset();
  toastMock.showSuccessToast.mockReset();
  dialogMock.open.mockReset();
  errorLogMock.captureError.mockReset();
  audioEngineMock.isMuted.mockReset();
  audioEngineMock.isMuted.mockReturnValue(false);
  mockBackend({});
  usePlayerStore.setState({
    isPlaying: false,
    playMode: "normal",
    playbackQueue: [],
    currentTrack: null,
  });
});

// ---------------------------------------------------------------------------
// queueMenuSlice — pure windowing
// ---------------------------------------------------------------------------
describe("queueMenuSlice", () => {
  const queue = Array.from({ length: 100 }, (_, i) =>
    track(`t${String(i)}`, `Track ${String(i)}`),
  );

  it("queue at or below the limit is returned whole", () => {
    const short = queue.slice(0, 50);
    expect(queueMenuSlice(short, "t10")).toEqual({ start: 0, items: short });
    expect(queueMenuSlice(short, null)).toEqual({ start: 0, items: short });
  });

  it("a current track inside the first window keeps it", () => {
    const slice = queueMenuSlice(queue, "t10", 50);
    expect(slice.start).toBe(0);
    expect(slice.items).toHaveLength(50);
  });

  it("a deep current track slides the window around it", () => {
    const slice = queueMenuSlice(queue, "t60", 50);
    expect(slice.start).toBe(35);
    expect(slice.items).toHaveLength(50);
    expect(slice.items.find((t) => t.id === "t60")).toBeDefined();
    expect(slice.items[0]?.id).toBe("t35");
  });

  it("a current track near the end clamps the window to the queue end", () => {
    const slice = queueMenuSlice(queue, "t95", 50);
    expect(slice.start).toBe(50);
    expect(slice.items).toHaveLength(50);
    expect(slice.items.find((t) => t.id === "t95")).toBeDefined();
  });

  it("a current track outside the queue (or null) falls back to the first window", () => {
    expect(queueMenuSlice(queue, "missing", 50).start).toBe(0);
    expect(queueMenuSlice(queue, null, 50).start).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildContextMenuModel — structure, labels, checked/enabled state
// ---------------------------------------------------------------------------
describe("buildContextMenuModel — full menu skeleton", () => {
  it("has the exact top-level order of the spec", () => {
    const entries = buildContextMenuModel("full", snapshot());

    expect(ids(entries)).toEqual([
      PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE,
      PLAYER_COMMAND_IDS.PLAYER_STOP,
      PLAYER_COMMAND_IDS.PLAYER_PREVIOUS,
      PLAYER_COMMAND_IDS.PLAYER_NEXT,
      "---",
      PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN,
      "---",
      MENU_IDS.fullAudio,
      MENU_IDS.fullVideo,
      MENU_IDS.fullSubtitle,
      MENU_IDS.fullPlayback,
      MENU_IDS.fullPlaylist,
      "---",
      PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT,
      PLAYER_COMMAND_IDS.PLAYER_MEDIA_INFO,
    ]);
  });

  it("dynamic pause/play label flips with isPaused and keeps the Space shortcut", () => {
    const playing = item(
      buildContextMenuModel("full", snapshot({ isPaused: false })),
      PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE,
    );
    const paused = item(
      buildContextMenuModel("full", snapshot({ isPaused: true })),
      PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE,
    );

    expect(playing.label).toBe(en.player.pause);
    expect(paused.label).toBe(en.player.play);
    expect(playing.shortcut).toBe(
      shortcutFor(PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE),
    );
  });

  it("dynamic fullscreen label flips with isFullscreen", () => {
    const windowed = item(
      buildContextMenuModel("full", snapshot({ isFullscreen: false })),
      PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN,
    );
    const full = item(
      buildContextMenuModel("full", snapshot({ isFullscreen: true })),
      PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN,
    );

    expect(windowed.label).toBe(en.player.fullscreen);
    expect(full.label).toBe(en.player.exit_fullscreen);
    expect(windowed.shortcut).toBe("F");
  });

  it("snapshot + media info carry their command shortcuts", () => {
    const entries = buildContextMenuModel("full", snapshot());
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT).shortcut).toBe(
      "Ctrl+S",
    );
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_MEDIA_INFO).shortcut).toBe(
      "I",
    );
  });
});

describe("buildContextMenuModel — audio section", () => {
  it("lists tracks with §24 labels, suffixes and checked state", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({
        tracks: [
          audioTrack(3, {
            title: "Commentary",
            lang: "en",
            forced: true,
            selected: true,
          }),
          audioTrack(4, { isDefault: true }),
        ],
        audioTrackId: 3,
      }),
    );
    const children = item(entries, MENU_IDS.audioTrack).children ?? [];

    expect(item(entries, MENU_IDS.audioTrack).label).toBe(
      en.player.menu.audio_track,
    );
    expect(item(children, `${MENU_PREFIXES.audio}3`).label).toBe(
      "Commentary — en (forced)",
    );
    expect(item(children, `${MENU_PREFIXES.audio}3`).checked).toBe(true);
    expect(item(children, `${MENU_PREFIXES.audio}4`).label).toBe(
      `${i18next.t("player.menu.audio_track_n", { n: 2 })} (default)`,
    );
    expect(item(children, `${MENU_PREFIXES.audio}4`).checked).toBe(false);
  });

  it("'no audio' is a real clickable choice, checked when no track is selected", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({ tracks: [audioTrack(1)], audioTrackId: null }),
    );
    const noEntry = item(entries, `${MENU_PREFIXES.audio}no`);

    expect(noEntry.enabled).toBe(true);
    expect(noEntry.checked).toBe(true);
    expect(noEntry.label).toBe(en.player.menu.no_audio);
  });

  it("the track parent disables when there are no audio tracks but keeps the child list", () => {
    const parent = item(
      buildContextMenuModel("full", snapshot()),
      MENU_IDS.audioTrack,
    );

    expect(parent.enabled).toBe(false);
    expect(parent.children).toHaveLength(1);
    const firstChild = parent.children?.[0];
    expect(firstChild?.kind === "item" ? firstChild.id : null).toBe(
      `${MENU_PREFIXES.audio}no`,
    );
  });

  it("audio devices use the description (name fallback) and check the current one", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({
        devices: [
          { name: "dev-a", description: "" },
          { name: "dev-b", description: "Headphones" },
        ],
        currentDevice: "dev-b",
      }),
    );

    expect(item(entries, MENU_IDS.audioDevice).enabled).toBe(true);
    expect(item(entries, `${MENU_PREFIXES.device}dev-a`).label).toBe("dev-a");
    expect(item(entries, `${MENU_PREFIXES.device}dev-b`).label).toBe(
      "Headphones",
    );
    expect(item(entries, `${MENU_PREFIXES.device}dev-b`).checked).toBe(true);
  });

  it("the device parent disables when no devices are available", () => {
    expect(
      item(buildContextMenuModel("full", snapshot()), MENU_IDS.audioDevice)
        .enabled,
    ).toBe(false);
  });

  it("mute reflects the engine state; volume items carry their shortcuts", () => {
    const entries = buildContextMenuModel("full", snapshot({ isMuted: true }));
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_MUTE).checked).toBe(true);
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP).shortcut).toBe(
      "Ctrl+Up",
    );
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_VOLUME_DOWN).shortcut).toBe(
      "Ctrl+Down",
    );
  });

  it("audio-delay children expose the three new shortcuts and menu ids", () => {
    const entries = buildContextMenuModel("full", snapshot());
    const children = item(entries, MENU_IDS.audioDelay).children ?? [];

    expect(item(children, `${MENU_PREFIXES.audioDelay}down`).shortcut).toBe(
      shortcutFor(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN),
    );
    expect(item(children, `${MENU_PREFIXES.audioDelay}up`).shortcut).toBe(
      shortcutFor(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP),
    );
    expect(item(children, `${MENU_PREFIXES.audioDelay}reset`).shortcut).toBe(
      shortcutFor(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET),
    );
  });
});

describe("buildContextMenuModel — video section", () => {
  function videoTrack(id: number, overrides: Partial<MpvTrack> = {}): MpvTrack {
    return { ...audioTrack(id, overrides), type: "video" };
  }

  it("video tracks are checked; the parent disables with one or zero tracks", () => {
    const two = buildContextMenuModel(
      "full",
      snapshot({ tracks: [videoTrack(1, { selected: true }), videoTrack(2)] }),
    );
    expect(item(two, MENU_IDS.videoTrack).enabled).toBe(true);
    expect(item(two, `${MENU_PREFIXES.video}1`).checked).toBe(true);
    expect(item(two, `${MENU_PREFIXES.video}2`).checked).toBe(false);

    const one = buildContextMenuModel(
      "full",
      snapshot({ tracks: [videoTrack(1, { selected: true })] }),
    );
    expect(item(one, MENU_IDS.videoTrack).enabled).toBe(false);
  });

  it("aspect presets check the current value with tolerance", () => {
    const entries = buildContextMenuModel("full", snapshot({ aspect: 16 / 9 }));
    expect(item(entries, `${MENU_PREFIXES.aspect}16/9`).checked).toBe(true);
    expect(item(entries, `${MENU_PREFIXES.aspect}-2`).checked).toBe(false);

    const auto = buildContextMenuModel(
      "full",
      snapshot({ aspect: ASPECT_AUTO }),
    );
    expect(item(auto, `${MENU_PREFIXES.aspect}-2`).label).toBe(
      en.player.menu.aspect_auto,
    );
    expect(item(auto, `${MENU_PREFIXES.aspect}-2`).checked).toBe(true);
  });

  it("zoom children mirror the command shortcuts", () => {
    const entries = buildContextMenuModel("full", snapshot());
    expect(item(entries, `${MENU_PREFIXES.zoom}reset`).shortcut).toBe("Ctrl+0");
    expect(item(entries, `${MENU_PREFIXES.zoom}in`).shortcut).toBe("Ctrl+=");
    expect(item(entries, `${MENU_PREFIXES.zoom}out`).shortcut).toBe("Ctrl+-");
  });

  it("crop items compute the rect from the video dimensions", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({
        videoWidth: 1920,
        videoHeight: 1080,
        crop: "1440x1080+240+0",
      }),
    );

    expect(item(entries, `${MENU_PREFIXES.crop}4/3`).checked).toBe(true);
    expect(item(entries, `${MENU_PREFIXES.crop}16/9`).checked).toBe(false);
    expect(item(entries, `${MENU_PREFIXES.crop}none`).checked).toBe(false);
    expect(item(entries, MENU_IDS.crop).enabled).toBe(true);
  });

  it("the crop parent disables without known dimensions and 'none' checks an empty crop", () => {
    const disabled = buildContextMenuModel(
      "full",
      snapshot({ videoWidth: null, videoHeight: null }),
    );
    expect(item(disabled, MENU_IDS.crop).enabled).toBe(false);

    const none = buildContextMenuModel(
      "full",
      snapshot({ videoWidth: 1920, videoHeight: 1080, crop: "" }),
    );
    expect(item(none, `${MENU_PREFIXES.crop}none`).checked).toBe(true);
  });

  it("deinterlace children check the current mode; the parent shows D", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({ deinterlace: "auto" }),
    );
    expect(item(entries, `${MENU_PREFIXES.deinterlace}auto`).checked).toBe(
      true,
    );
    expect(item(entries, `${MENU_PREFIXES.deinterlace}no`).label).toBe(
      en.player.menu.deinterlace_off,
    );
    expect(item(entries, MENU_IDS.deinterlace).shortcut).toBe("D");
  });

  it("fullscreen / fit / snapshot live inside the video section too", () => {
    const entries = buildContextMenuModel(
      "video",
      snapshot({ isFullscreen: true }),
    );
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN).label).toBe(
      en.player.exit_fullscreen,
    );
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_FIT_WINDOW).shortcut).toBe(
      "Ctrl+0",
    );
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT).shortcut).toBe(
      "Ctrl+S",
    );
  });
});

describe("buildContextMenuModel — subtitle section", () => {
  function subTrack(id: number, overrides: Partial<MpvTrack> = {}): MpvTrack {
    return { ...audioTrack(id, overrides), type: "sub" };
  }

  it("track parent carries V, disables without tracks, but Add Subtitle stays enabled", () => {
    const entries = buildContextMenuModel("full", snapshot());
    expect(item(entries, MENU_IDS.subtitleTrack).shortcut).toBe("V");
    expect(item(entries, MENU_IDS.subtitleTrack).enabled).toBe(false);
    expect(item(entries, MENU_IDS.addSubtitle).enabled).toBe(true);
  });

  it("subtitle tracks are listed and checked; 'no subtitle' is clickable (disable is a real choice)", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({
        tracks: [subTrack(7, { title: "English", lang: "en", selected: true })],
        subtitleTrackId: 7,
        subtitleVisible: true,
      }),
    );
    const children = item(entries, MENU_IDS.subtitleTrack).children ?? [];

    expect(item(children, `${MENU_PREFIXES.sub}7`).label).toBe("English — en");
    expect(item(children, `${MENU_PREFIXES.sub}7`).checked).toBe(true);
    expect(item(children, `${MENU_PREFIXES.sub}no`).enabled).toBe(true);
    expect(item(children, `${MENU_PREFIXES.sub}no`).checked).toBe(false);
    expect(
      item(entries, PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_VISIBLE).checked,
    ).toBe(true);
  });

  it("secondary subtitle checks the current id and enables with sub tracks", () => {
    const disabled = buildContextMenuModel("full", snapshot());
    expect(item(disabled, MENU_IDS.secondarySubtitle).enabled).toBe(false);

    const entries = buildContextMenuModel(
      "full",
      snapshot({ tracks: [subTrack(7)], secondarySubtitleId: null }),
    );
    expect(item(entries, MENU_IDS.secondarySubtitle).enabled).toBe(true);
    expect(item(entries, `${MENU_PREFIXES.secondary}no`).enabled).toBe(true);
    expect(item(entries, `${MENU_PREFIXES.secondary}no`).checked).toBe(true);
    expect(item(entries, `${MENU_PREFIXES.secondary}7`).checked).toBe(false);
  });

  it("sub-delay children expose G / H / Shift+H", () => {
    const entries = buildContextMenuModel("full", snapshot());
    expect(item(entries, `${MENU_PREFIXES.subDelay}down`).shortcut).toBe("G");
    expect(item(entries, `${MENU_PREFIXES.subDelay}up`).shortcut).toBe("H");
    expect(item(entries, `${MENU_PREFIXES.subDelay}reset`).shortcut).toBe(
      "Shift+H",
    );
  });
});

describe("buildContextMenuModel — playback section", () => {
  it("speed presets check the current value with tolerance", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({ speed: 1.2500001 }),
    );
    expect(item(entries, `${MENU_PREFIXES.speed}1.25`).checked).toBe(true);
    expect(item(entries, `${MENU_PREFIXES.speed}1`).checked).toBe(false);
    expect(item(entries, `${MENU_PREFIXES.speed}1.25`).label).toBe("1.25x");
  });

  it("chapters are listed with fallback labels and check the current index", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({
        chapters: [
          { title: "Intro", time: 0 },
          { title: null, time: 60 },
        ],
        currentChapter: 1,
      }),
    );
    const children = item(entries, MENU_IDS.chapters).children ?? [];

    expect(item(children, `${MENU_PREFIXES.chapter}0`).label).toBe("Intro");
    expect(item(children, `${MENU_PREFIXES.chapter}1`).label).toBe(
      i18next.t("player.menu.chapter_n", { n: 2 }),
    );
    expect(item(children, `${MENU_PREFIXES.chapter}1`).checked).toBe(true);
    expect(item(entries, MENU_IDS.chapters).enabled).toBe(true);
  });

  it("the chapters parent disables without chapters", () => {
    expect(
      item(buildContextMenuModel("full", snapshot()), MENU_IDS.chapters)
        .enabled,
    ).toBe(false);
  });

  it("A-B loop entries reflect the loop points", () => {
    const empty = buildContextMenuModel("full", snapshot());
    expect(item(empty, MENU_IDS.setA).checked).toBe(false);
    expect(item(empty, MENU_IDS.clearAb).enabled).toBe(false);

    const looped = buildContextMenuModel(
      "full",
      snapshot({ abLoop: { a: 10, b: null } }),
    );
    expect(item(looped, MENU_IDS.setA).checked).toBe(true);
    expect(item(looped, MENU_IDS.setB).checked).toBe(false);
    expect(item(looped, MENU_IDS.clearAb).enabled).toBe(true);
  });
});

describe("buildContextMenuModel — playlist section", () => {
  it("queue items get numbered labels, truncation and the current marker", () => {
    const queue = [track("a", "First"), track("b", "Second")];
    const entries = buildContextMenuModel(
      "playlist",
      snapshot({ queue, currentTrackId: "b", playMode: "shuffle" }),
    );

    expect(item(entries, `${MENU_PREFIXES.queue}a`).label).toBe("1. First");
    expect(item(entries, `${MENU_PREFIXES.queue}b`).label).toBe("2. Second");
    expect(item(entries, `${MENU_PREFIXES.queue}b`).checked).toBe(true);
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_SHUFFLE).checked).toBe(true);
    expect(item(entries, PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE).shortcut).toBe(
      "F8",
    );
  });

  it("a long queue title is truncated to the label budget", () => {
    const long = track("a", "T".repeat(100));
    const entries = buildContextMenuModel(
      "playlist",
      snapshot({ queue: [long] }),
    );
    const label = item(entries, `${MENU_PREFIXES.queue}a`).label;

    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.endsWith("…")).toBe(true);
  });

  it("repeat children check the active play mode", () => {
    const entries = buildContextMenuModel(
      "full",
      snapshot({ playMode: "repeat-one" }),
    );
    expect(item(entries, `${MENU_PREFIXES.repeat}repeat-one`).checked).toBe(
      true,
    );
    expect(item(entries, `${MENU_PREFIXES.repeat}repeat-one`).label).toBe(
      en.player.menu.repeat_track,
    );
    expect(item(entries, `${MENU_PREFIXES.repeat}normal`).checked).toBe(false);
    expect(item(entries, `${MENU_PREFIXES.repeat}repeat-all`).label).toBe(
      en.player.menu.repeat_queue,
    );
  });
});

describe("buildContextMenuModel — sections expose the submenu children", () => {
  it("every non-full section equals the children of its submenu in the full menu", () => {
    const s = snapshot({
      tracks: [
        audioTrack(1),
        { ...audioTrack(2), type: "video" },
        { ...audioTrack(3), type: "sub" },
      ],
      devices: [{ name: "d", description: "D" }],
      chapters: [{ title: "c", time: 0 }],
      queue: [track("a", "A")],
      videoWidth: 1920,
      videoHeight: 1080,
    });
    const full = buildContextMenuModel("full", s);

    expect(buildContextMenuModel("audio", s)).toEqual(
      item(full, MENU_IDS.fullAudio).children,
    );
    expect(buildContextMenuModel("video", s)).toEqual(
      item(full, MENU_IDS.fullVideo).children,
    );
    expect(buildContextMenuModel("subtitle", s)).toEqual(
      item(full, MENU_IDS.fullSubtitle).children,
    );
    expect(buildContextMenuModel("playback", s)).toEqual(
      item(full, MENU_IDS.fullPlayback).children,
    );
    expect(buildContextMenuModel("playlist", s)).toEqual(
      item(full, MENU_IDS.fullPlaylist).children,
    );
  });
});

// ---------------------------------------------------------------------------
// takeVideoMenuSnapshot
// ---------------------------------------------------------------------------
describe("takeVideoMenuSnapshot", () => {
  it("collects facade + store data in one pass", async () => {
    usePlayerStore.setState({
      isPlaying: true,
      playMode: "repeat-all",
      playbackQueue: [track("t1", "Song")],
      currentTrack: track("t1", "Song"),
    });
    mockBackend({
      "track-list": [
        audioTrack(1, { selected: true }),
        { ...audioTrack(2), type: "sub", selected: false },
      ],
      "audio-device-list": [{ name: "dev0", description: "Speakers" }],
      "audio-device": "dev0",
      "chapter-list": [{ title: "Intro", time: 0 }],
      chapter: 0,
      speed: 1.25,
      "video-aspect-override": 16 / 9,
      "video-crop": "",
      deinterlace: "auto",
      "sub-delay": 0.05,
      "audio-delay": -0.1,
      "ab-loop-a": 10,
      "ab-loop-b": "no",
      "sub-visibility": true,
      "secondary-sid": 3,
      width: 1920,
      height: 1080,
    });

    const snap = await takeVideoMenuSnapshot(true);

    expect(snap.isPaused).toBe(false);
    expect(snap.isFullscreen).toBe(true);
    expect(snap.isMuted).toBe(false);
    expect(snap.audioTrackId).toBe(1);
    expect(snap.subtitleTrackId).toBe(null);
    expect(snap.subtitleVisible).toBe(true);
    expect(snap.secondarySubtitleId).toBe(3);
    expect(snap.devices).toEqual([{ name: "dev0", description: "Speakers" }]);
    expect(snap.currentDevice).toBe("dev0");
    expect(snap.chapters).toEqual([{ title: "Intro", time: 0 }]);
    expect(snap.currentChapter).toBe(0);
    expect(snap.speed).toBe(1.25);
    expect(snap.aspect).toBeCloseTo(16 / 9);
    expect(snap.crop).toBe("");
    expect(snap.deinterlace).toBe("auto");
    expect(snap.subDelay).toBe(0.05);
    expect(snap.audioDelay).toBe(-0.1);
    expect(snap.abLoop).toEqual({ a: 10, b: null });
    expect(snap.queue).toEqual([track("t1", "Song")]);
    expect(snap.currentTrackId).toBe("t1");
    expect(snap.playMode).toBe("repeat-all");
    expect(snap.videoWidth).toBe(1920);
    expect(snap.videoHeight).toBe(1080);
  });

  it("a paused store flips isPaused; muted engine flips isMuted", async () => {
    audioEngineMock.isMuted.mockReturnValue(true);
    const snap = await takeVideoMenuSnapshot(false);

    expect(snap.isPaused).toBe(true);
    expect(snap.isMuted).toBe(true);
  });

  it("a failing getter degrades to its fallback and is logged once", async () => {
    mockBackend({}, ["speed", "track-list", "sub-visibility"]);

    const first = await takeVideoMenuSnapshot(false);
    const second = await takeVideoMenuSnapshot(false);

    expect(first.speed).toBe(1);
    expect(first.tracks).toEqual([]);
    expect(first.subtitleVisible).toBe(false);
    expect(second.speed).toBe(1);
    expect(errorLogMock.captureError).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// runMenuEntry — dispatcher
// ---------------------------------------------------------------------------
describe("runMenuEntry — command ids", () => {
  it("PLAYER_* ids run through the command registry", async () => {
    const ctx = makeCtx();

    await runMenuEntry(PLAYER_COMMAND_IDS.PLAYER_MUTE, ctx, snapshot());
    expect(ctx._audio.toggleMute).toHaveBeenCalledTimes(1);

    await runMenuEntry(PLAYER_COMMAND_IDS.PLAYER_MEDIA_INFO, ctx, snapshot());
    // media-info only emits on the UI bus — reachable without throwing.
  });

  it("menu aliases of commands reuse the exact command implementation", async () => {
    const ctx = makeCtx();

    await runMenuEntry(`${MENU_PREFIXES.subDelay}down`, ctx, snapshot());
    expect(lastCommand()).toEqual(["add", "sub-delay", "-0.05"]);

    await runMenuEntry(`${MENU_PREFIXES.audioDelay}down`, ctx, snapshot());
    expect(lastCommand()).toEqual(["add", "audio-delay", "-0.1"]);

    await runMenuEntry(`${MENU_PREFIXES.audioDelay}up`, ctx, snapshot());
    expect(lastCommand()).toEqual(["add", "audio-delay", "0.1"]);

    await runMenuEntry(`${MENU_PREFIXES.audioDelay}reset`, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "audio-delay", "0"]);
  });

  it("the three audio-delay commands are registered with the spec chords", async () => {
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN)).toBe(
      "Ctrl+Alt+Left",
    );
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP)).toBe(
      "Ctrl+Alt+Right",
    );
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET)).toBe(
      "Ctrl+Alt+Down",
    );

    const ctx = makeCtx();
    await commandById(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN).run(ctx);
    expect(lastCommand()).toEqual(["add", "audio-delay", "-0.1"]);
    await commandById(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP).run(ctx);
    expect(lastCommand()).toEqual(["add", "audio-delay", "0.1"]);
    await commandById(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET).run(ctx);
    expect(lastCommand()).toEqual(["set_property", "audio-delay", "0"]);
  });
});

describe("runMenuEntry — track / device / chapter / speed / aspect / zoom / crop / deinterlace", () => {
  it("audio, video, sub and secondary track ids write aid / vid / sid / secondary-sid", async () => {
    const ctx = makeCtx();

    await runMenuEntry(`${MENU_PREFIXES.audio}5`, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "aid", "5"]);
    await runMenuEntry(`${MENU_PREFIXES.audio}no`, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "aid", "no"]);

    await runMenuEntry(`${MENU_PREFIXES.video}2`, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "vid", "2"]);

    await runMenuEntry(`${MENU_PREFIXES.sub}7`, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "sid", "7"]);
    await runMenuEntry(`${MENU_PREFIXES.sub}no`, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "sid", "no"]);

    await runMenuEntry(`${MENU_PREFIXES.secondary}3`, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "secondary-sid", "3"]);
    await runMenuEntry(`${MENU_PREFIXES.secondary}no`, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "secondary-sid", "no"]);
  });

  it("device names survive an encode/decode roundtrip", async () => {
    const ctx = makeCtx();
    const name = 'Surround 5.1 "Test" → ✦';
    await runMenuEntry(
      `${MENU_PREFIXES.device}${encodeURIComponent(name)}`,
      ctx,
      snapshot(),
    );

    expect(lastCommand()).toEqual(["set_property", "audio-device", name]);
  });

  it("a malformed device name is rejected clearly", async () => {
    const ctx = makeCtx();
    await expect(
      runMenuEntry(`${MENU_PREFIXES.device}%E0%A4%A`, ctx, snapshot()),
    ).rejects.toThrow(/device/i);
  });

  it("chapters, speed, aspect, zoom, crop and deinterlace dispatch to the facade", async () => {
    const ctx = makeCtx();
    const s = snapshot({ videoWidth: 1920, videoHeight: 1080 });

    await runMenuEntry(`${MENU_PREFIXES.chapter}2`, ctx, s);
    expect(lastCommand()).toEqual(["set_property", "chapter", "2"]);

    await runMenuEntry(`${MENU_PREFIXES.speed}1.25`, ctx, s);
    expect(lastCommand()).toEqual(["set_property", "speed", "1.25"]);

    await runMenuEntry(`${MENU_PREFIXES.aspect}16/9`, ctx, s);
    expect(lastCommand()).toEqual([
      "set_property",
      "video-aspect-override",
      String(16 / 9),
    ]);
    await runMenuEntry(`${MENU_PREFIXES.aspect}-2`, ctx, s);
    expect(lastCommand()).toEqual([
      "set_property",
      "video-aspect-override",
      "-2",
    ]);

    await runMenuEntry(`${MENU_PREFIXES.zoom}in`, ctx, s);
    expect(lastCommand()).toEqual(["add", "video-zoom", "0.1"]);
    await runMenuEntry(`${MENU_PREFIXES.zoom}out`, ctx, s);
    expect(lastCommand()).toEqual(["add", "video-zoom", "-0.1"]);
    await runMenuEntry(`${MENU_PREFIXES.zoom}reset`, ctx, s);
    expect(lastCommand()).toEqual(["set_property", "video-pan-y", "0"]);

    await runMenuEntry(`${MENU_PREFIXES.crop}none`, ctx, s);
    expect(lastCommand()).toEqual(["set_property", "video-crop", ""]);
    await runMenuEntry(`${MENU_PREFIXES.crop}4/3`, ctx, s);
    expect(lastCommand()).toEqual([
      "set_property",
      "video-crop",
      cropRectFor(1920, 1080, 4 / 3),
    ]);

    await runMenuEntry(`${MENU_PREFIXES.deinterlace}auto`, ctx, s);
    expect(lastCommand()).toEqual(["set_property", "deinterlace", "auto"]);
  });

  it("crop without known dimensions fails with context instead of a guessed rect", async () => {
    const ctx = makeCtx();
    await expect(
      runMenuEntry(`${MENU_PREFIXES.crop}16/9`, ctx, snapshot()),
    ).rejects.toThrow(/crop/i);
  });
});

describe("runMenuEntry — ab loop / add subtitle / repeat / queue", () => {
  it("A / B pin the engine clock; clear wipes both points", async () => {
    const ctx = makeCtx();

    await runMenuEntry(MENU_IDS.setA, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "ab-loop-a", "100"]);
    await runMenuEntry(MENU_IDS.setB, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "ab-loop-b", "100"]);
    await runMenuEntry(MENU_IDS.clearAb, ctx, snapshot());
    expect(lastCommand()).toEqual(["set_property", "ab-loop-b", "no"]);

    const calls = tauriMocks.invoke.mock.calls as unknown as Array<
      [string, { cmd?: unknown[] } | undefined]
    >;
    const commands = calls
      .filter((call) => call[0] === "mpv_command")
      .map((call) => call[1]?.cmd);
    expect(commands).toContainEqual(["set_property", "ab-loop-a", "no"]);
  });

  it("add-subtitle opens the picker with subtitle filters, loads the file and toasts", async () => {
    const ctx = makeCtx();
    dialogMock.open.mockResolvedValue("C:\\subs\\movie.srt");

    await runMenuEntry(MENU_IDS.addSubtitle, ctx, snapshot());

    const openCalls = dialogMock.open.mock.calls as unknown as Array<
      [
        {
          multiple?: boolean;
          directory?: boolean;
          filters?: { extensions?: string[] }[];
        }?,
      ]
    >;
    const openArgs = openCalls[0]?.[0];
    expect(openArgs?.multiple).toBe(false);
    expect(openArgs?.directory).toBe(false);
    expect(openArgs?.filters?.[0]?.extensions).toEqual(
      expect.arrayContaining(["srt", "ass"]),
    );
    expect(lastCommand()).toEqual(["sub-add", "C:\\subs\\movie.srt", "select"]);
    expect(toastMock.showSuccessToast).toHaveBeenCalledTimes(1);
  });

  it("a cancelled picker is a silent no-op", async () => {
    const ctx = makeCtx();
    dialogMock.open.mockResolvedValue(null);

    await runMenuEntry(MENU_IDS.addSubtitle, ctx, snapshot());

    expect(
      (tauriMocks.invoke.mock.calls as unknown as Array<[string]>).filter(
        (call) => call[0] === "mpv_command",
      ),
    ).toHaveLength(0);
    expect(toastMock.showSuccessToast).not.toHaveBeenCalled();
  });

  it("repeat entries set the play mode via the context", async () => {
    const ctx = makeCtx();
    await runMenuEntry(`${MENU_PREFIXES.repeat}repeat-one`, ctx, snapshot());
    expect(ctx.setPlayMode).toHaveBeenCalledWith("repeat-one");

    await expect(
      runMenuEntry(`${MENU_PREFIXES.repeat}bogus`, ctx, snapshot()),
    ).rejects.toThrow(/repeat/i);
  });

  it("queue items select the track from the snapshot queue", async () => {
    const ctx = makeCtx();
    const a = track("a", "A");
    const b = track("b", "B");

    await runMenuEntry(
      `${MENU_PREFIXES.queue}b`,
      ctx,
      snapshot({ queue: [a, b] }),
    );

    expect(ctx.selectTrack).toHaveBeenCalledWith(b);
  });

  it("a queue item missing from the snapshot queue fails clearly", async () => {
    const ctx = makeCtx();
    await expect(
      runMenuEntry(`${MENU_PREFIXES.queue}ghost`, ctx, snapshot()),
    ).rejects.toThrow(/queue/i);
  });

  it("an unknown id is rejected loudly", async () => {
    const ctx = makeCtx();
    await expect(
      runMenuEntry("menu:does-not-exist", ctx, snapshot()),
    ).rejects.toThrow(/unknown menu entry/i);
  });
});
