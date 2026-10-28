import i18next from "i18next";
import type { NativeMenuEntry } from "../../../lib/nativeMenu";
import { PLAYER_COMMAND_IDS } from "../../commands";
import { MENU_IDS, MENU_PREFIXES } from "../constants";
import { commandEntry, menuItem, playPauseEntry } from "../entries";
import { truncateLabel } from "../labels";
import type { VideoMenuSnapshot } from "../snapshot";
import { SEPARATOR_ENTRY } from "./constants";

const SPEED_EPSILON = 1e-3;

const SPEED_MENU_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function playbackSubmenuChildren(
  s: VideoMenuSnapshot,
): NativeMenuEntry[] {
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
