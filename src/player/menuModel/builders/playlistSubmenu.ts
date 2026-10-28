/**
 * Playlist submenu.
 *
 * NOTE: intentional import cycle with `../builders` — `builders.ts` imports
 * `playlistSubmenuChildren` from here while this module imports
 * `queueMenuSlice` back from it. Safe because `queueMenuSlice` is a hoisted
 * `function` declaration only called at menu-build time (not module init), and
 * the repo does not enable `import/no-cycle`.
 */
import i18next from "i18next";
import type { NativeMenuEntry } from "../../../lib/nativeMenu";
import { episodeNumberFromName } from "../../../utils/episodeNumber";
import { MEDIA_KIND_VIDEO, classifyMediaKind } from "../../../utils/mediaKind";
import type { Track } from "../../../types";
import { PLAYER_COMMAND_IDS } from "../../commands";
import { queueMenuSlice } from "../builders";
import { MENU_IDS, MENU_PREFIXES, REPEAT_MENU_PRESETS } from "../constants";
import { commandEntry, menuItem } from "../entries";
import { truncateLabel } from "../labels";
import type { VideoMenuSnapshot } from "../snapshot";
import { SEPARATOR_ENTRY } from "./constants";

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

export function playlistSubmenuChildren(
  s: VideoMenuSnapshot,
): NativeMenuEntry[] {
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
