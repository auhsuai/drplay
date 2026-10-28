import { usePlayerStore } from "../../../store/playerStore";
import { PLAYER_COMMAND_IDS, type PlayerCommand } from "../ids";
import { commandModifier, noModifiers } from "./helpers";

export const QUEUE_COMMANDS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE,
    labelKey: "player.command.queue_toggle",
    // F8 is the canonical binding (spec §8/§11); Ctrl+Q is kept as an alias
    // of this SAME command so the old shortcut keeps its exact behavior.
    shortcut: "F8",
    preventDefault: true,
    match: (e) =>
      (noModifiers(e) && e.key === "F8") ||
      (commandModifier(e) && e.key.toLowerCase() === "q"),
    run: (ctx) => {
      ctx.toggleQueue();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_PLAYMODE_CYCLE,
    labelKey: "player.command.playmode_cycle",
    // No keyboard binding (spec §8 gives F8 to the queue) — the command stays
    // defined for the D2b menu, which runs it through runPlayerCommand.
    shortcut: "",
    preventDefault: false,
    match: () => false,
    run: (ctx) => {
      // Reuses App's NEXT_MODE handler (usePlayerQueue.handleTogglePlayMode).
      ctx.togglePlayMode();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SHUFFLE,
    labelKey: "player.command.shuffle",
    shortcut: "Ctrl+Shift+S",
    preventDefault: true,
    match: (e) =>
      commandModifier(e) && e.shiftKey && e.key.toLowerCase() === "s",
    run: (ctx) => {
      // Toggle shuffle on/off through App's handleSetPlayMode, which rebuilds
      // the playback queue with the existing shuffle logic — no new logic here.
      const { playMode } = usePlayerStore.getState();
      ctx.setPlayMode(playMode === "shuffle" ? "normal" : "shuffle");
    },
  },
];
