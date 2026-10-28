import { emitPlayerUi } from "../../playerUiBus";
import {
  PLAYER_COMMAND_IDS,
  type PlayerCommand,
  type PlayerCommandContext,
} from "../ids";
import { commandModifier, noModifiers } from "./helpers";

/** Volume nudge per keypress — same 0.1 step the VolumeSlider drag uses. */
export const VOLUME_STEP = 0.1;

function adjustVolume(ctx: PlayerCommandContext, direction: 1 | -1): void {
  const next = Math.max(
    0,
    Math.min(1, ctx.audio.getVolume() + direction * VOLUME_STEP),
  );
  ctx.audio.setVolume(next);
  emitPlayerUi("volume-changed", {
    volume: next,
    muted: ctx.audio.isMuted(),
  });
}

export const VOLUME_COMMANDS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_MUTE,
    labelKey: "player.command.mute",
    shortcut: "M",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "m",
    run: (ctx) => {
      ctx.audio.toggleMute();
      emitPlayerUi("volume-changed", {
        volume: ctx.audio.getVolume(),
        muted: ctx.audio.isMuted(),
      });
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP,
    labelKey: "player.command.volume_up",
    shortcut: "\u2191 / Ctrl+\u2191",
    preventDefault: true,
    repeatable: true,
    match: (e) =>
      (noModifiers(e) || commandModifier(e)) &&
      !e.shiftKey &&
      e.key === "ArrowUp",
    run: (ctx) => {
      adjustVolume(ctx, 1);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_VOLUME_DOWN,
    labelKey: "player.command.volume_down",
    shortcut: "\u2193 / Ctrl+\u2193",
    preventDefault: true,
    repeatable: true,
    match: (e) =>
      (noModifiers(e) || commandModifier(e)) &&
      !e.shiftKey &&
      e.key === "ArrowDown",
    run: (ctx) => {
      adjustVolume(ctx, -1);
    },
  },
];
