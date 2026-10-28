import i18next from "i18next";
import type { NativeMenuEntry } from "../../../lib/nativeMenu";
import { PLAYER_COMMAND_IDS } from "../../commands";
import { MENU_IDS, MENU_PREFIXES, TRACK_NONE } from "../constants";
import {
  commandEntry,
  menuCommandEntry,
  menuItem,
  trackEntry,
} from "../entries";
import { truncateLabel } from "../labels";
import type { VideoMenuSnapshot } from "../snapshot";

export function audioSubmenuChildren(s: VideoMenuSnapshot): NativeMenuEntry[] {
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
