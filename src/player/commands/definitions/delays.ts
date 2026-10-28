import {
  addAudioDelay,
  addSubDelay,
  resetAudioDelay,
  resetSubDelay,
} from "../../../lib/mpvControl";
import { PLAYER_COMMAND_IDS, type PlayerCommand } from "../ids";
import { noModifiers } from "./helpers";

/** Subtitle/audio delay nudge per keypress (VLC-style 50 ms). */
const SUB_DELAY_STEP_SECONDS = 0.05;
/** Audio delay nudge per keypress (spec §4: 100 ms). */
const AUDIO_DELAY_STEP_SECONDS = 0.1;

/** Ctrl+Alt chord: the audio-delay trio (disjoint from every other matcher). */
function audioDelayModifier(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.altKey;
}

export const DELAY_COMMANDS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_DOWN,
    labelKey: "player.command.sub_delay_down",
    shortcut: "G",
    preventDefault: false,
    repeatable: true,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key.toLowerCase() === "g",
    run: async () => {
      await addSubDelay(-SUB_DELAY_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_UP,
    labelKey: "player.command.sub_delay_up",
    shortcut: "H",
    preventDefault: false,
    repeatable: true,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key.toLowerCase() === "h",
    run: async () => {
      await addSubDelay(SUB_DELAY_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_RESET,
    labelKey: "player.command.sub_delay_reset",
    shortcut: "Shift+H",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.shiftKey && e.key.toLowerCase() === "h",
    run: async () => {
      await resetSubDelay();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN,
    labelKey: "player.command.audio_delay_down",
    shortcut: "Ctrl+Alt+Left",
    preventDefault: true,
    repeatable: true,
    match: (e) => audioDelayModifier(e) && e.key === "ArrowLeft",
    run: async () => {
      await addAudioDelay(-AUDIO_DELAY_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP,
    labelKey: "player.command.audio_delay_up",
    shortcut: "Ctrl+Alt+Right",
    preventDefault: true,
    repeatable: true,
    match: (e) => audioDelayModifier(e) && e.key === "ArrowRight",
    run: async () => {
      await addAudioDelay(AUDIO_DELAY_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET,
    labelKey: "player.command.audio_delay_reset",
    shortcut: "Ctrl+Alt+Down",
    preventDefault: true,
    match: (e) => audioDelayModifier(e) && e.key === "ArrowDown",
    run: async () => {
      await resetAudioDelay();
    },
  },
];
