import i18next from "i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { AudioController } from "../lib/AudioController";
import {
  ASPECT_AUTO,
  ASPECT_NO,
  addSubtitleFile,
  addVideoZoom,
  clearAbLoop,
  cropRectFor,
  getAbLoop,
  getAspectOverride,
  getAudioDelay,
  getAudioDevice,
  getAudioDevices,
  getChapters,
  getCrop,
  getCurrentChapter,
  getDeinterlace,
  getSecondarySubtitleId,
  getSpeed,
  getSubDelay,
  getSubtitleVisibility,
  getTrackList,
  getVideoDimensions,
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
  SPEED_NORMAL,
  type AbLoopPoints,
  type MpvAudioDevice,
  type MpvChapter,
  type MpvTrack,
} from "../lib/mpvControl";
import { describeError } from "../lib/mpvProtocol";
import { captureError } from "../utils/errorLog";
import { showSuccessToast } from "../utils/simpleToast";
import { usePlayerStore } from "../store/playerStore";
import type { NativeMenuEntry } from "../lib/nativeMenu";
import {
  PLAYER_COMMAND_IDS,
  VIDEO_ZOOM_STEP,
  commandById,
  shortcutFor,
  type PlayerCommandContext,
  type PlayerCommandId,
} from "./commands";
import { runPlayerCommand } from "./usePlayerCommands";
import type { PlayMode, Track } from "../types";

/**
 * Video context-menu model (D2b). PURE data: one snapshot read when the menu
 * opens (spec §22), one builder per section, one dispatcher for the returned
 * item id. The registry (commands.ts) stays the single source of truth for
 * command labels/shortcuts/behavior — menu-only entries use `menu:*` ids and
 * are dispatched here.
 */

const LOGGER_SOURCE = "menuModel";

/** Label budget: native menus clip long strings, so long titles are cut. */
export const MENU_LABEL_MAX_LENGTH = 60;
const TRACK_LABEL_SEPARATOR = " — ";
const TRACK_LABEL_FORCED_SUFFIX = " (forced)";
const TRACK_LABEL_DEFAULT_SUFFIX = " (default)";
const LABEL_ELLIPSIS = "…";

/** mpv `chapter` reports "no chapter" as null; -1 means "nothing checked". */
const NO_CHAPTER = -1;
/** Fallback when the deinterlace property cannot be read (mpv default). */
const DEINTERLACE_DEFAULT = "no";
/** Queue slice window (spec §playlist). */
export const DEFAULT_QUEUE_MENU_LIMIT = 50;

const RATIO_EPSILON = 1e-3;
const SPEED_EPSILON = 1e-3;

const SPEED_MENU_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

const ASPECT_MENU_PRESETS = [
  { id: "-2", labelKey: "player.menu.aspect_auto", ratio: ASPECT_AUTO },
  { id: "16/9", labelKey: "player.menu.aspect_16_9", ratio: 16 / 9 },
  { id: "4/3", labelKey: "player.menu.aspect_4_3", ratio: 4 / 3 },
  { id: "21/9", labelKey: "player.menu.aspect_21_9", ratio: 21 / 9 },
  { id: "1", labelKey: "player.menu.aspect_1_1", ratio: 1 },
] as const;

const CROP_MENU_PRESETS = [
  { id: "16/9", labelKey: "player.menu.aspect_16_9", ratio: 16 / 9 },
  { id: "4/3", labelKey: "player.menu.aspect_4_3", ratio: 4 / 3 },
] as const;

const DEINTERLACE_MENU_PRESETS = [
  { value: "no", labelKey: "player.menu.deinterlace_off" },
  { value: "auto", labelKey: "player.menu.deinterlace_auto" },
  { value: "yes", labelKey: "player.menu.deinterlace_on" },
] as const;

const REPEAT_MENU_PRESETS = [
  { mode: "normal", labelKey: "player.menu.repeat_off" },
  { mode: "repeat-one", labelKey: "player.menu.repeat_track" },
  { mode: "repeat-all", labelKey: "player.menu.repeat_queue" },
] as const;

/** Parent/leaf ids the builder emits; also the dispatcher's vocabulary. */
export const MENU_IDS = {
  fullAudio: "menu:audio",
  fullVideo: "menu:video",
  fullSubtitle: "menu:subtitle",
  fullPlayback: "menu:playback",
  fullPlaylist: "menu:playlist",
  audioTrack: "menu:audio-track",
  audioDevice: "menu:audio-device",
  audioDelay: "menu:audio-delay",
  videoTrack: "menu:video-track",
  aspect: "menu:aspect",
  zoom: "menu:zoom",
  crop: "menu:crop",
  deinterlace: "menu:deinterlace",
  subtitleTrack: "menu:subtitle-track",
  secondarySubtitle: "menu:secondary-subtitle",
  addSubtitle: "menu:add-subtitle",
  subDelay: "menu:sub-delay",
  speed: "menu:speed",
  chapters: "menu:chapters",
  setA: "menu:ab:a",
  setB: "menu:ab:b",
  clearAb: "menu:ab:clear",
  repeat: "menu:repeat",
} as const;

export const MENU_PREFIXES = {
  audio: "menu:audio:",
  device: "menu:device:",
  video: "menu:video:",
  sub: "menu:sub:",
  secondary: "menu:secondary:",
  chapter: "menu:chapter:",
  speed: "menu:speed:",
  aspect: "menu:aspect:",
  zoom: "menu:zoom:",
  crop: "menu:crop:",
  deinterlace: "menu:deinterlace:",
  subDelay: "menu:sub-delay:",
  audioDelay: "menu:audio-delay:",
  repeat: "menu:repeat:",
  queue: "menu:queue:",
} as const;

/** mpv track-selection sentinel ("no" disables the track). */
const TRACK_NONE = "no";
const AUDIO_DEVICE_NAME_CONTEXT = "audio device name";

const SUBTITLE_FILE_EXTENSIONS: readonly string[] = [
  "srt",
  "ass",
  "ssa",
  "sub",
  "vtt",
];

const SEPARATOR_ENTRY: NativeMenuEntry = { kind: "separator" };

// ---------------------------------------------------------------------------
// Snapshot (spec §22 — read ONCE when the menu opens)
// ---------------------------------------------------------------------------

export interface VideoMenuSnapshot {
  isPaused: boolean;
  isFullscreen: boolean;
  /** Audio-engine mute state (spec: the Mute item's checked flag). */
  isMuted: boolean;
  tracks: MpvTrack[];
  audioTrackId: number | null;
  subtitleTrackId: number | null;
  subtitleVisible: boolean;
  secondarySubtitleId: number | null;
  devices: MpvAudioDevice[];
  currentDevice: string | null;
  chapters: MpvChapter[];
  currentChapter: number;
  speed: number;
  /** mpv `video-aspect-override`: -2 auto, other numbers are overrides. */
  aspect: number;
  /** mpv `video-crop`: "" = none. */
  crop: string;
  deinterlace: string;
  subDelay: number;
  audioDelay: number;
  abLoop: AbLoopPoints;
  queue: Track[];
  currentTrackId: string | null;
  playMode: PlayMode;
  videoWidth: number | null;
  videoHeight: number | null;
}

/**
 * Warn once per failing operation for the whole session: a broken getter must
 * degrade the menu, not spam the log on every right-click.
 */
const warnedOperations = new Set<string>();

function warnSnapshotOnce(operation: string, error: unknown): void {
  if (warnedOperations.has(operation)) return;
  warnedOperations.add(operation);
  void captureError({
    level: "warn",
    source: LOGGER_SOURCE,
    message: `snapshot-get-failed ${operation}: ${describeError(error)}`,
    kind: "video-menu-snapshot-get-failed",
  });
}

/**
 * Every snapshot read goes through this: one failing getter degrades to its
 * fallback (the menu still opens, the submenu just lacks that data) and the
 * failure is logged once — never thrown.
 */
async function safeGet<T>(
  operation: string,
  read: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read();
  } catch (e: unknown) {
    warnSnapshotOnce(operation, e);
    return fallback;
  }
}

/** A 0 dimension means "unknown" (no video) — the menu works in nulls. */
function knownDimension(value: number): number | null {
  return value > 0 ? value : null;
}

export async function takeVideoMenuSnapshot(
  isFullscreen: boolean,
): Promise<VideoMenuSnapshot> {
  const [
    tracks,
    devices,
    currentDevice,
    chapters,
    rawCurrentChapter,
    speed,
    aspect,
    crop,
    deinterlace,
    subDelay,
    audioDelay,
    abLoop,
    subtitleVisible,
    secondarySubtitleId,
    dimensions,
    isMuted,
  ] = await Promise.all([
    safeGet("track-list", getTrackList, []),
    safeGet("audio-device-list", getAudioDevices, []),
    safeGet("audio-device", getAudioDevice, null),
    safeGet("chapter-list", getChapters, []),
    safeGet("chapter", getCurrentChapter, NO_CHAPTER),
    safeGet("speed", getSpeed, SPEED_NORMAL),
    safeGet("video-aspect-override", getAspectOverride, ASPECT_NO),
    safeGet("video-crop", getCrop, ""),
    safeGet("deinterlace", getDeinterlace, DEINTERLACE_DEFAULT),
    safeGet("sub-delay", getSubDelay, 0),
    safeGet("audio-delay", getAudioDelay, 0),
    safeGet("ab-loop", getAbLoop, { a: null, b: null }),
    safeGet("sub-visibility", getSubtitleVisibility, false),
    safeGet("secondary-sid", getSecondarySubtitleId, null),
    safeGet("video-dimensions", getVideoDimensions, { width: 0, height: 0 }),
    safeGet("is-muted", () => AudioController.getInstance().isMuted(), false),
  ]);

  const audioTracks = tracks.filter((track) => track.type === "audio");
  const subtitleTracks = tracks.filter((track) => track.type === "sub");
  const state = usePlayerStore.getState();

  return {
    isPaused: !state.isPlaying,
    isFullscreen,
    isMuted,
    tracks,
    audioTrackId: audioTracks.find((track) => track.selected)?.id ?? null,
    subtitleTrackId: subtitleTracks.find((track) => track.selected)?.id ?? null,
    subtitleVisible,
    secondarySubtitleId,
    devices,
    currentDevice,
    chapters,
    currentChapter: rawCurrentChapter ?? NO_CHAPTER,
    speed,
    aspect,
    crop,
    deinterlace,
    subDelay,
    audioDelay,
    abLoop,
    queue: state.playbackQueue,
    currentTrackId: state.currentTrack?.id ?? null,
    playMode: state.playMode,
    videoWidth: knownDimension(dimensions.width),
    videoHeight: knownDimension(dimensions.height),
  };
}

// ---------------------------------------------------------------------------
// Entry constructors
// ---------------------------------------------------------------------------

interface MenuItemFields {
  id: string;
  label: string;
  shortcut?: string;
  enabled?: boolean;
  checked?: boolean;
  children?: NativeMenuEntry[];
}

/** One place that turns optional fields into an exactOptionalPropertyTypes-safe item. */
function menuItem(fields: MenuItemFields): NativeMenuEntry {
  return {
    kind: "item",
    id: fields.id,
    label: fields.label,
    ...(fields.shortcut !== undefined ? { shortcut: fields.shortcut } : {}),
    ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {}),
    ...(fields.checked !== undefined ? { checked: fields.checked } : {}),
    ...(fields.children !== undefined ? { children: fields.children } : {}),
  };
}

/** A leaf that runs a registry command — label/shortcut can never drift. */
function commandEntry(
  id: PlayerCommandId,
  overrides: { label?: string; checked?: boolean } = {},
): NativeMenuEntry {
  const command = commandById(id);
  return menuItem({
    id: command.id,
    label: overrides.label ?? translateCommandLabel(command.labelKey),
    ...(command.shortcut !== "" ? { shortcut: command.shortcut } : {}),
    ...(overrides.checked !== undefined ? { checked: overrides.checked } : {}),
  });
}

/**
 * The registry stores labelKey as a plain string (the literal lives at its
 * definition site in commands.ts), so the strict i18next key union cannot see
 * through the variable. The defaultValue overload is i18next's string-key
 * signature; a missing key then falls back to the key itself, like before.
 */
function translateCommandLabel(labelKey: string): string {
  return i18next.t(labelKey, { defaultValue: labelKey });
}

/** A leaf that reuses a command's label/shortcut but carries a `menu:*` id. */
function menuCommandEntry(
  menuId: string,
  commandId: PlayerCommandId,
  checked?: boolean,
): NativeMenuEntry {
  const command = commandById(commandId);
  return menuItem({
    id: menuId,
    label: translateCommandLabel(command.labelKey),
    ...(command.shortcut !== "" ? { shortcut: command.shortcut } : {}),
    ...(checked !== undefined ? { checked } : {}),
  });
}

function playPauseEntry(s: VideoMenuSnapshot): NativeMenuEntry {
  return commandEntry(PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE, {
    label: i18next.t(s.isPaused ? "player.play" : "player.pause"),
  });
}

function fullscreenEntry(s: VideoMenuSnapshot): NativeMenuEntry {
  return commandEntry(PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN, {
    label: i18next.t(
      s.isFullscreen ? "player.exit_fullscreen" : "player.fullscreen",
    ),
  });
}

export function truncateLabel(
  label: string,
  maxLength = MENU_LABEL_MAX_LENGTH,
): string {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1)}${LABEL_ELLIPSIS}`;
}

/**
 * §24 track label: `<title> — <lang>` (fallback `Audio Track 2` etc.), plus
 * the forced/default suffixes, truncated to the label budget.
 */
export function formatTrackLabel(track: MpvTrack, fallback: string): string {
  const parts: string[] = [];
  if (track.title !== undefined && track.title !== "") parts.push(track.title);
  if (track.lang !== undefined && track.lang !== "") parts.push(track.lang);
  const base = parts.length > 0 ? parts.join(TRACK_LABEL_SEPARATOR) : fallback;
  const suffix = `${track.forced ? TRACK_LABEL_FORCED_SUFFIX : ""}${track.isDefault ? TRACK_LABEL_DEFAULT_SUFFIX : ""}`;
  return truncateLabel(`${base}${suffix}`);
}

function trackEntry(
  prefix: string,
  track: MpvTrack,
  fallback: string,
  checked: boolean,
): NativeMenuEntry {
  return menuItem({
    id: `${prefix}${String(track.id)}`,
    label: formatTrackLabel(track, fallback),
    checked,
  });
}

// ---------------------------------------------------------------------------
// Submenu builders (spec §4-§8)
// ---------------------------------------------------------------------------

function audioSubmenuChildren(s: VideoMenuSnapshot): NativeMenuEntry[] {
  const audioTracks = s.tracks.filter((track) => track.type === "audio");
  const trackChildren: NativeMenuEntry[] = [
    // "Disable" is a REAL choice (spec §6/§13), not a disabled placeholder:
    // clicking it writes "no" to aid/sid and the check marks the off state.
    menuItem({
      id: `${MENU_PREFIXES.audio}${TRACK_NONE}`,
      label: i18next.t("player.menu.no_audio"),
      enabled: true,
      checked: s.audioTrackId === null,
    }),
    ...audioTracks.map((track, index) =>
      trackEntry(
        MENU_PREFIXES.audio,
        track,
        i18next.t("player.menu.audio_track_n", { n: index + 1 }),
        track.id === s.audioTrackId,
      ),
    ),
  ];
  const deviceChildren = s.devices.map((device) =>
    menuItem({
      id: `${MENU_PREFIXES.device}${encodeURIComponent(device.name)}`,
      label: truncateLabel(
        device.description !== "" ? device.description : device.name,
      ),
      checked: device.name === s.currentDevice,
    }),
  );

  return [
    menuItem({
      id: MENU_IDS.audioTrack,
      label: i18next.t("player.menu.audio_track"),
      enabled: audioTracks.length > 0,
      children: trackChildren,
    }),
    menuItem({
      id: MENU_IDS.audioDevice,
      label: i18next.t("player.menu.audio_device"),
      enabled: s.devices.length > 0,
      children: deviceChildren,
    }),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_VOLUME_DOWN),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_MUTE, { checked: s.isMuted }),
    menuItem({
      id: MENU_IDS.audioDelay,
      label: i18next.t("player.menu.audio_delay"),
      children: [
        menuCommandEntry(
          `${MENU_PREFIXES.audioDelay}down`,
          PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN,
        ),
        menuCommandEntry(
          `${MENU_PREFIXES.audioDelay}up`,
          PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP,
        ),
        menuCommandEntry(
          `${MENU_PREFIXES.audioDelay}reset`,
          PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET,
        ),
      ],
    }),
  ];
}

function videoSubmenuChildren(s: VideoMenuSnapshot): NativeMenuEntry[] {
  const videoTracks = s.tracks.filter((track) => track.type === "video");
  const trackChildren = videoTracks.map((track, index) =>
    trackEntry(
      MENU_PREFIXES.video,
      track,
      i18next.t("player.menu.video_track_n", { n: index + 1 }),
      track.selected,
    ),
  );
  const aspectChildren = ASPECT_MENU_PRESETS.map((preset) =>
    menuItem({
      id: `${MENU_PREFIXES.aspect}${preset.id}`,
      label: i18next.t(preset.labelKey),
      checked: Math.abs(s.aspect - preset.ratio) < RATIO_EPSILON,
    }),
  );
  const cropAvailable =
    s.videoWidth !== null &&
    s.videoHeight !== null &&
    s.videoWidth > 0 &&
    s.videoHeight > 0;
  const cropChildren: NativeMenuEntry[] = [
    menuItem({
      id: `${MENU_PREFIXES.crop}none`,
      label: i18next.t("player.menu.crop_none"),
      checked: s.crop === "",
    }),
  ];
  if (cropAvailable) {
    for (const preset of CROP_MENU_PRESETS) {
      const rect = cropRectFor(
        s.videoWidth ?? 0,
        s.videoHeight ?? 0,
        preset.ratio,
      );
      cropChildren.push(
        menuItem({
          id: `${MENU_PREFIXES.crop}${preset.id}`,
          label: i18next.t(preset.labelKey),
          checked: rect !== "" && s.crop === rect,
        }),
      );
    }
  }

  return [
    menuItem({
      id: MENU_IDS.videoTrack,
      label: i18next.t("player.menu.video_track"),
      enabled: videoTracks.length > 1,
      children: trackChildren,
    }),
    fullscreenEntry(s),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_FIT_WINDOW),
    menuItem({
      id: MENU_IDS.aspect,
      label: i18next.t("player.menu.aspect"),
      children: aspectChildren,
    }),
    menuItem({
      id: MENU_IDS.zoom,
      label: i18next.t("player.menu.zoom"),
      children: [
        menuCommandEntry(
          `${MENU_PREFIXES.zoom}reset`,
          PLAYER_COMMAND_IDS.PLAYER_FIT_WINDOW,
        ),
        menuCommandEntry(
          `${MENU_PREFIXES.zoom}in`,
          PLAYER_COMMAND_IDS.PLAYER_ZOOM_IN,
        ),
        menuCommandEntry(
          `${MENU_PREFIXES.zoom}out`,
          PLAYER_COMMAND_IDS.PLAYER_ZOOM_OUT,
        ),
      ],
    }),
    menuItem({
      id: MENU_IDS.crop,
      label: i18next.t("player.menu.crop"),
      enabled: cropAvailable,
      children: cropChildren,
    }),
    menuItem({
      id: MENU_IDS.deinterlace,
      label: i18next.t("player.menu.deinterlace"),
      shortcut: shortcutFor(PLAYER_COMMAND_IDS.PLAYER_DEINTERLACE_CYCLE),
      children: DEINTERLACE_MENU_PRESETS.map((preset) =>
        menuItem({
          id: `${MENU_PREFIXES.deinterlace}${preset.value}`,
          label: i18next.t(preset.labelKey),
          checked: s.deinterlace === preset.value,
        }),
      ),
    }),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT),
  ];
}

function subtitleSubmenuChildren(s: VideoMenuSnapshot): NativeMenuEntry[] {
  const subtitleTracks = s.tracks.filter((track) => track.type === "sub");
  const trackChildren: NativeMenuEntry[] = [
    // "No subtitle" is the clickable disable choice (writes sid=no).
    menuItem({
      id: `${MENU_PREFIXES.sub}${TRACK_NONE}`,
      label: i18next.t("player.menu.no_subtitle"),
      enabled: true,
      checked: s.subtitleTrackId === null,
    }),
    ...subtitleTracks.map((track, index) =>
      trackEntry(
        MENU_PREFIXES.sub,
        track,
        i18next.t("player.menu.subtitle_track_n", { n: index + 1 }),
        track.id === s.subtitleTrackId,
      ),
    ),
  ];
  const secondaryChildren: NativeMenuEntry[] = [
    // Clickable disable choice for the secondary subtitle (secondary-sid=no).
    menuItem({
      id: `${MENU_PREFIXES.secondary}${TRACK_NONE}`,
      label: i18next.t("player.menu.no_subtitle"),
      enabled: true,
      checked: s.secondarySubtitleId === null,
    }),
    ...subtitleTracks.map((track, index) =>
      trackEntry(
        MENU_PREFIXES.secondary,
        track,
        i18next.t("player.menu.subtitle_track_n", { n: index + 1 }),
        track.id === s.secondarySubtitleId,
      ),
    ),
  ];

  return [
    menuItem({
      id: MENU_IDS.subtitleTrack,
      label: i18next.t("player.menu.subtitle_track"),
      shortcut: shortcutFor(PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_NEXT),
      enabled: subtitleTracks.length > 0,
      children: trackChildren,
    }),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_VISIBLE, {
      checked: s.subtitleVisible,
    }),
    menuItem({
      id: MENU_IDS.secondarySubtitle,
      label: i18next.t("player.menu.secondary_subtitle"),
      enabled: subtitleTracks.length > 0,
      children: secondaryChildren,
    }),
    menuItem({
      id: MENU_IDS.addSubtitle,
      label: i18next.t("player.menu.add_subtitle"),
      enabled: true,
    }),
    menuItem({
      id: MENU_IDS.subDelay,
      label: i18next.t("player.menu.sub_delay"),
      children: [
        menuCommandEntry(
          `${MENU_PREFIXES.subDelay}down`,
          PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_DOWN,
        ),
        menuCommandEntry(
          `${MENU_PREFIXES.subDelay}up`,
          PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_UP,
        ),
        menuCommandEntry(
          `${MENU_PREFIXES.subDelay}reset`,
          PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_RESET,
        ),
      ],
    }),
  ];
}

function playbackSubmenuChildren(s: VideoMenuSnapshot): NativeMenuEntry[] {
  return [
    playPauseEntry(s),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_STOP),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_PREVIOUS),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_NEXT),
    SEPARATOR_ENTRY,
    menuItem({
      id: MENU_IDS.speed,
      label: i18next.t("player.menu.speed"),
      children: SPEED_MENU_PRESETS.map((preset) =>
        menuItem({
          id: `${MENU_PREFIXES.speed}${String(preset)}`,
          label: `${String(preset)}x`,
          checked: Math.abs(s.speed - preset) < SPEED_EPSILON,
        }),
      ),
    }),
    SEPARATOR_ENTRY,
    menuItem({
      id: MENU_IDS.chapters,
      label: i18next.t("player.menu.chapters"),
      enabled: s.chapters.length > 0,
      children: s.chapters.map((chapter, index) =>
        menuItem({
          id: `${MENU_PREFIXES.chapter}${String(index)}`,
          label:
            chapter.title !== null && chapter.title !== ""
              ? truncateLabel(chapter.title)
              : i18next.t("player.menu.chapter_n", { n: index + 1 }),
          checked: index === s.currentChapter,
        }),
      ),
    }),
    SEPARATOR_ENTRY,
    menuItem({
      id: MENU_IDS.setA,
      label: i18next.t("player.menu.set_a"),
      checked: s.abLoop.a !== null,
    }),
    menuItem({
      id: MENU_IDS.setB,
      label: i18next.t("player.menu.set_b"),
      checked: s.abLoop.b !== null,
    }),
    menuItem({
      id: MENU_IDS.clearAb,
      label: i18next.t("player.menu.clear_ab"),
      enabled: s.abLoop.a !== null || s.abLoop.b !== null,
    }),
  ];
}

function playlistSubmenuChildren(s: VideoMenuSnapshot): NativeMenuEntry[] {
  const slice = queueMenuSlice(s.queue, s.currentTrackId);
  const queueItems = slice.items.map((track, index) =>
    menuItem({
      id: `${MENU_PREFIXES.queue}${encodeURIComponent(track.id)}`,
      label: truncateLabel(
        `${String(slice.start + index + 1)}. ${track.title}`,
      ),
      checked: track.id === s.currentTrackId,
    }),
  );

  return [
    ...queueItems,
    // Only when there is a queue to separate from the commands below.
    ...(queueItems.length > 0 ? [SEPARATOR_ENTRY] : []),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE),
    commandEntry(PLAYER_COMMAND_IDS.PLAYER_SHUFFLE, {
      checked: s.playMode === "shuffle",
    }),
    menuItem({
      id: MENU_IDS.repeat,
      label: i18next.t("player.menu.repeat"),
      children: REPEAT_MENU_PRESETS.map((preset) =>
        menuItem({
          id: `${MENU_PREFIXES.repeat}${preset.mode}`,
          label: i18next.t(preset.labelKey),
          checked: s.playMode === preset.mode,
        }),
      ),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export type MenuSection =
  "full" | "audio" | "video" | "subtitle" | "playback" | "playlist";

/**
 * Build one section of the menu tree. `full` is the whole right-click menu
 * (spec §3); every other section is the CHILDREN of its submenu, so the D3
 * playerbar buttons can reuse the exact same content.
 */
export function buildContextMenuModel(
  section: MenuSection,
  s: VideoMenuSnapshot,
): NativeMenuEntry[] {
  switch (section) {
    case "full":
      return [
        playPauseEntry(s),
        commandEntry(PLAYER_COMMAND_IDS.PLAYER_STOP),
        commandEntry(PLAYER_COMMAND_IDS.PLAYER_PREVIOUS),
        commandEntry(PLAYER_COMMAND_IDS.PLAYER_NEXT),
        SEPARATOR_ENTRY,
        fullscreenEntry(s),
        SEPARATOR_ENTRY,
        menuItem({
          id: MENU_IDS.fullAudio,
          label: i18next.t("player.menu.audio"),
          children: audioSubmenuChildren(s),
        }),
        menuItem({
          id: MENU_IDS.fullVideo,
          label: i18next.t("player.menu.video"),
          children: videoSubmenuChildren(s),
        }),
        menuItem({
          id: MENU_IDS.fullSubtitle,
          label: i18next.t("player.menu.subtitle"),
          children: subtitleSubmenuChildren(s),
        }),
        menuItem({
          id: MENU_IDS.fullPlayback,
          label: i18next.t("player.menu.playback"),
          children: playbackSubmenuChildren(s),
        }),
        menuItem({
          id: MENU_IDS.fullPlaylist,
          label: i18next.t("player.menu.playlist"),
          children: playlistSubmenuChildren(s),
        }),
        SEPARATOR_ENTRY,
        commandEntry(PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT),
        commandEntry(PLAYER_COMMAND_IDS.PLAYER_MEDIA_INFO),
      ];
    case "audio":
      return audioSubmenuChildren(s);
    case "video":
      return videoSubmenuChildren(s);
    case "subtitle":
      return subtitleSubmenuChildren(s);
    case "playback":
      return playbackSubmenuChildren(s);
    case "playlist":
      return playlistSubmenuChildren(s);
  }
}

/**
 * Queue window for the Playlist submenu: the whole queue when it fits the
 * budget, otherwise a window centered on the current track (clamped to the
 * queue end); a current track outside the queue (or null) shows the head.
 */
export function queueMenuSlice(
  queue: Track[],
  currentTrackId: string | null,
  limit = DEFAULT_QUEUE_MENU_LIMIT,
): { start: number; items: Track[] } {
  if (queue.length <= limit) return { start: 0, items: queue };
  let start = 0;
  if (currentTrackId !== null) {
    const index = queue.findIndex((track) => track.id === currentTrackId);
    if (index > limit - 1) {
      start = Math.min(
        Math.max(index - Math.floor(limit / 2), 0),
        queue.length - limit,
      );
    }
  }
  return { start, items: queue.slice(start, start + limit) };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const COMMAND_ID_SET: ReadonlySet<string> = new Set(
  Object.values(PLAYER_COMMAND_IDS),
);

function decodeSegment(segment: string, context: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (e: unknown) {
    throw new Error(`Invalid ${context}: ${describeError(e)}`);
  }
}

function parseTrackRef(segment: string, context: string): number | "no" {
  if (segment === TRACK_NONE) return "no";
  const id = Number(segment);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid ${context} track id: ${segment}`);
  }
  return id;
}

function parseRatio(value: string): number | null {
  const parts = value.split("/");
  if (parts.length === 1) {
    const single = Number(value);
    return Number.isFinite(single) ? single : null;
  }
  if (parts.length !== 2) return null;
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  return numerator / denominator;
}

function runDelayAlias(
  segment: string,
  aliases: Readonly<Record<string, PlayerCommandId>>,
  ctx: PlayerCommandContext,
): void {
  const commandId = aliases[segment];
  if (commandId === undefined) {
    throw new Error(`Unknown delay action: ${segment}`);
  }
  runPlayerCommand(commandId, ctx);
}

async function runZoomAction(segment: string): Promise<void> {
  switch (segment) {
    case "reset":
      await resetVideoView();
      return;
    case "in":
      await addVideoZoom(VIDEO_ZOOM_STEP);
      return;
    case "out":
      await addVideoZoom(-VIDEO_ZOOM_STEP);
      return;
    default:
      throw new Error(`Unknown zoom action: ${segment}`);
  }
}

async function runCropAction(
  segment: string,
  s: VideoMenuSnapshot,
): Promise<void> {
  if (segment === "none") {
    await setCrop("");
    return;
  }
  const ratio = parseRatio(segment);
  if (ratio === null || ratio <= 0) {
    throw new Error(`Invalid crop ratio: ${segment}`);
  }
  const { videoWidth, videoHeight } = s;
  if (
    videoWidth === null ||
    videoHeight === null ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    throw new Error(
      "Cannot apply a crop preset: the video dimensions are unknown",
    );
  }
  const rect = cropRectFor(videoWidth, videoHeight, ratio);
  if (rect === "") {
    throw new Error(`Cannot compute a crop rect for ratio ${segment}`);
  }
  await setCrop(rect);
}

async function pickSubtitleFile(): Promise<void> {
  let selected: string | null;
  try {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: i18next.t("player.menu.subtitle_files"),
          extensions: [...SUBTITLE_FILE_EXTENSIONS],
        },
      ],
    });
    selected = typeof picked === "string" ? picked : null;
  } catch (e: unknown) {
    throw new Error(`subtitle picker failed: ${describeError(e)}`);
  }
  // Cancelled / no selection: nothing to add.
  if (selected === null) return;
  await addSubtitleFile(selected);
  showSuccessToast(i18next.t("player.menu.add_subtitle_success"));
}

function runRepeatAction(segment: string, ctx: PlayerCommandContext): void {
  const mode = REPEAT_MENU_PRESETS.find((preset) => preset.mode === segment);
  if (mode === undefined) {
    throw new Error(`Unknown repeat mode: ${segment}`);
  }
  ctx.setPlayMode(mode.mode);
}

function selectQueuedTrack(
  segment: string,
  ctx: PlayerCommandContext,
  s: VideoMenuSnapshot,
): void {
  const trackId = decodeSegment(segment, "queue track id");
  const track = s.queue.find((candidate) => candidate.id === trackId);
  if (track === undefined) {
    throw new Error(`Queue track not found in the snapshot: ${trackId}`);
  }
  ctx.selectTrack(track);
}

/**
 * Run the item the native menu returned. `PLAYER_*` ids go through the shared
 * command registry; `menu:*` ids dispatch to the mpvControl facade (or reuse a
 * command when one already implements the exact action). Unknown ids throw —
 * the caller surfaces the failure, nothing is ever swallowed.
 */
export async function runMenuEntry(
  id: string,
  ctx: PlayerCommandContext,
  s: VideoMenuSnapshot,
): Promise<void> {
  if (COMMAND_ID_SET.has(id)) {
    runPlayerCommand(id as PlayerCommandId, ctx);
    return;
  }

  if (id.startsWith(MENU_PREFIXES.audioDelay)) {
    runDelayAlias(
      id.slice(MENU_PREFIXES.audioDelay.length),
      {
        down: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN,
        up: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP,
        reset: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET,
      },
      ctx,
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.subDelay)) {
    runDelayAlias(
      id.slice(MENU_PREFIXES.subDelay.length),
      {
        down: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_DOWN,
        up: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_UP,
        reset: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_RESET,
      },
      ctx,
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.audio)) {
    await setAudioTrack(
      parseTrackRef(id.slice(MENU_PREFIXES.audio.length), "audio"),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.video)) {
    await setVideoTrack(
      parseTrackRef(id.slice(MENU_PREFIXES.video.length), "video"),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.sub)) {
    await setSubtitleTrack(
      parseTrackRef(id.slice(MENU_PREFIXES.sub.length), "subtitle"),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.secondary)) {
    await setSecondarySubtitle(
      parseTrackRef(
        id.slice(MENU_PREFIXES.secondary.length),
        "secondary subtitle",
      ),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.device)) {
    await setAudioDevice(
      decodeSegment(
        id.slice(MENU_PREFIXES.device.length),
        AUDIO_DEVICE_NAME_CONTEXT,
      ),
    );
    return;
  }
  if (id.startsWith(MENU_PREFIXES.chapter)) {
    const index = Number(id.slice(MENU_PREFIXES.chapter.length));
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid chapter index: ${id}`);
    }
    await setChapter(index);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.speed)) {
    const speed = Number(id.slice(MENU_PREFIXES.speed.length));
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error(`Invalid speed value: ${id}`);
    }
    await setSpeed(speed);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.aspect)) {
    const segment = id.slice(MENU_PREFIXES.aspect.length);
    if (segment === String(ASPECT_AUTO)) {
      await setAspectOverride("auto");
      return;
    }
    const ratio = parseRatio(segment);
    if (ratio === null || ratio <= 0) {
      throw new Error(`Invalid aspect value: ${segment}`);
    }
    await setAspectOverride(ratio);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.zoom)) {
    await runZoomAction(id.slice(MENU_PREFIXES.zoom.length));
    return;
  }
  if (id.startsWith(MENU_PREFIXES.crop)) {
    await runCropAction(id.slice(MENU_PREFIXES.crop.length), s);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.deinterlace)) {
    const segment = id.slice(MENU_PREFIXES.deinterlace.length);
    const preset = DEINTERLACE_MENU_PRESETS.find(
      (candidate) => candidate.value === segment,
    );
    if (preset === undefined) {
      throw new Error(`Unknown deinterlace mode: ${segment}`);
    }
    await setDeinterlace(preset.value);
    return;
  }
  if (id === MENU_IDS.setA) {
    await setAbLoopA(ctx.audio.getCurrentTime());
    return;
  }
  if (id === MENU_IDS.setB) {
    await setAbLoopB(ctx.audio.getCurrentTime());
    return;
  }
  if (id === MENU_IDS.clearAb) {
    await clearAbLoop();
    return;
  }
  if (id === MENU_IDS.addSubtitle) {
    await pickSubtitleFile();
    return;
  }
  if (id.startsWith(MENU_PREFIXES.repeat)) {
    runRepeatAction(id.slice(MENU_PREFIXES.repeat.length), ctx);
    return;
  }
  if (id.startsWith(MENU_PREFIXES.queue)) {
    selectQueuedTrack(id.slice(MENU_PREFIXES.queue.length), ctx, s);
    return;
  }

  throw new Error(`Unknown menu entry id: ${id}`);
}
