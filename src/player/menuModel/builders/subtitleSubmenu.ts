import i18next from "i18next";
import type { NativeMenuEntry } from "../../../lib/nativeMenu";
import { PLAYER_COMMAND_IDS, shortcutFor } from "../../commands";
import { MENU_IDS, MENU_PREFIXES, TRACK_NONE } from "../constants";
import {
  commandEntry,
  menuCommandEntry,
  menuItem,
  trackEntry,
} from "../entries";
import type { VideoMenuSnapshot } from "../snapshot";

export function subtitleSubmenuChildren(
  s: VideoMenuSnapshot,
): NativeMenuEntry[] {
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
