import i18next from "i18next";
import type { NativeMenuEntry } from "../../lib/nativeMenu";
import type { Track } from "../../types";
import { PLAYER_COMMAND_IDS } from "../commands";
import { audioSubmenuChildren } from "./builders/audioSubmenu";
import { SEPARATOR_ENTRY } from "./builders/constants";
import { playbackSubmenuChildren } from "./builders/playbackSubmenu";
import { playlistSubmenuChildren } from "./builders/playlistSubmenu";
import { subtitleSubmenuChildren } from "./builders/subtitleSubmenu";
import { videoSubmenuChildren } from "./builders/videoSubmenu";
import { DEFAULT_QUEUE_MENU_LIMIT, MENU_IDS } from "./constants";
import {
  commandEntry,
  fullscreenEntry,
  menuItem,
  playPauseEntry,
} from "./entries";
import type { VideoMenuSnapshot } from "./snapshot";

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
