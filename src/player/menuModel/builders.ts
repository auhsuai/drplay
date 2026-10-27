import i18next from "i18next";
import { ASPECT_AUTO, cropRectFor } from "../../lib/mpvControl";
import type { NativeMenuEntry } from "../../lib/nativeMenu";
import { episodeNumberFromName } from "../../utils/episodeNumber";
import { MEDIA_KIND_VIDEO, classifyMediaKind } from "../../utils/mediaKind";
import type { Track } from "../../types";
import { PLAYER_COMMAND_IDS, shortcutFor } from "../commands";
import {
  DEFAULT_QUEUE_MENU_LIMIT,
  DEINTERLACE_MENU_PRESETS,
  MENU_IDS,
  MENU_PREFIXES,
  REPEAT_MENU_PRESETS,
  TRACK_NONE,
} from "./constants";
import {
  commandEntry,
  fullscreenEntry,
  menuCommandEntry,
  menuItem,
  playPauseEntry,
  trackEntry,
} from "./entries";
import { truncateLabel } from "./labels";
import type { VideoMenuSnapshot } from "./snapshot";

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

const SEPARATOR_ENTRY: NativeMenuEntry = { kind: "separator" };

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

/**
 * The right-aligned episode badge of a queue row, or undefined when the name
 * holds no confident episode number.
 *
 * Only VIDEO files get one: an mp3's bare "10" (`Album - 10 Tracks`) is a track
 * count, not an episode, and a name alone cannot tell the two apart — the
 * extension can. `originalName` is the raw Drive filename, which is what the
 * release patterns are written against; `title` is the fallback.
 */
function queueRowDetail(track: Track): string | undefined {
  const name = track.originalName ?? track.title;
  if (name === "") return undefined;
  if (classifyMediaKind(name) !== MEDIA_KIND_VIDEO) return undefined;
  return episodeNumberFromName(name) ?? undefined;
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
      detail: queueRowDetail(track),
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
        menuItem({
          id: MENU_IDS.pip,
          label: i18next.t("player.picture_in_picture"),
        }),
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
