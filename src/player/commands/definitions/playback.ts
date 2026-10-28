import {
  getSpeed,
  setSpeed,
  SPEED_NORMAL,
  speedStep,
} from "../../../lib/mpvControl";
import { PLAYER_COMMAND_IDS, type PlayerCommand } from "../ids";
import { noModifiers } from "./helpers";

export const PLAYBACK_COMMANDS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SPEED_DOWN,
    labelKey: "player.command.speed_down",
    shortcut: "[",
    preventDefault: false,
    repeatable: true,
    match: (e) => noModifiers(e) && e.key === "[",
    run: async () => {
      await setSpeed(speedStep(await getSpeed(), -1));
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SPEED_UP,
    labelKey: "player.command.speed_up",
    shortcut: "]",
    preventDefault: false,
    repeatable: true,
    match: (e) => noModifiers(e) && e.key === "]",
    run: async () => {
      await setSpeed(speedStep(await getSpeed(), 1));
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SPEED_NORMAL,
    labelKey: "player.command.speed_normal",
    shortcut: "=",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key === "=",
    run: async () => {
      await setSpeed(SPEED_NORMAL);
    },
  },
];
