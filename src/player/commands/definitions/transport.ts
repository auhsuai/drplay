import { seekRelative, SEEK_STEP_SECONDS } from "../../../hooks/player/utils";
import { usePlayerStore } from "../../../store/playerStore";
import { resetAdvanceGuard } from "../../../utils/playerError";
import { PLAYER_COMMAND_IDS, type PlayerCommand } from "../ids";
import { noModifiers } from "./helpers";

/** Fine seek step (Shift+Arrow). */
const SEEK_STEP_FINE_SECONDS = 1;
/** Long seek step (Shift+ArrowUp/Down). */
const SEEK_STEP_LARGE_SECONDS = 60;

export const TRANSPORT_COMMANDS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE,
    labelKey: "player.command.play_pause",
    shortcut: "Space",
    preventDefault: true,
    match: (e) => noModifiers(e) && e.key === " ",
    run: (ctx) => {
      // Manual transport action: same storm-guard reset the PlayerBar buttons
      // apply (Fix I: buttons + keyboard reset, auto-advance does not).
      resetAdvanceGuard();
      ctx.togglePlay();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_STOP,
    labelKey: "player.command.stop",
    shortcut: "S",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "s",
    run: (ctx) => {
      // No live track: pausing would latch the engine's pause intent onto the
      // NEXT load — stop must stay a no-op (mirror of the engine's seek guard).
      if (!usePlayerStore.getState().currentTrack) return;
      ctx.audio.pause();
      ctx.audio.seek(0);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_PREVIOUS,
    labelKey: "player.command.previous",
    shortcut: "P",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "p",
    run: (ctx) => {
      resetAdvanceGuard();
      ctx.previous();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_NEXT,
    labelKey: "player.command.next",
    shortcut: "N",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "n",
    run: (ctx) => {
      resetAdvanceGuard();
      ctx.next();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_5,
    labelKey: "player.command.seek_forward_5",
    shortcut: "\u2192 5s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key === "ArrowRight",
    run: (ctx) => {
      seekRelative(ctx.audio, SEEK_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_5,
    labelKey: "player.command.seek_backward_5",
    shortcut: "\u2190 5s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key === "ArrowLeft",
    run: (ctx) => {
      seekRelative(ctx.audio, -SEEK_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_1,
    labelKey: "player.command.seek_forward_1",
    shortcut: "Shift+\u2192 1s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && e.shiftKey && e.key === "ArrowRight",
    run: (ctx) => {
      seekRelative(ctx.audio, SEEK_STEP_FINE_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_1,
    labelKey: "player.command.seek_backward_1",
    shortcut: "Shift+\u2190 1s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && e.shiftKey && e.key === "ArrowLeft",
    run: (ctx) => {
      seekRelative(ctx.audio, -SEEK_STEP_FINE_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_60,
    labelKey: "player.command.seek_forward_60",
    shortcut: "Shift+\u2191 60s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && e.shiftKey && e.key === "ArrowUp",
    run: (ctx) => {
      seekRelative(ctx.audio, SEEK_STEP_LARGE_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_60,
    labelKey: "player.command.seek_backward_60",
    shortcut: "Shift+\u2193 60s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && e.shiftKey && e.key === "ArrowDown",
    run: (ctx) => {
      seekRelative(ctx.audio, -SEEK_STEP_LARGE_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN,
    labelKey: "player.command.fullscreen",
    shortcut: "F",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "f",
    run: (ctx) => {
      ctx.toggleFullscreen();
    },
  },
];
