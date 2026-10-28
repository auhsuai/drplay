import i18next from "i18next";
import { ASPECT_AUTO, cropRectFor } from "../../../lib/mpvControl";
import type { NativeMenuEntry } from "../../../lib/nativeMenu";
import { PLAYER_COMMAND_IDS, shortcutFor } from "../../commands";
import {
  DEINTERLACE_MENU_PRESETS,
  MENU_IDS,
  MENU_PREFIXES,
} from "../constants";
import {
  commandEntry,
  fullscreenEntry,
  menuCommandEntry,
  menuItem,
  trackEntry,
} from "../entries";
import type { VideoMenuSnapshot } from "../snapshot";

const RATIO_EPSILON = 1e-3;

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

export function videoSubmenuChildren(s: VideoMenuSnapshot): NativeMenuEntry[] {
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
