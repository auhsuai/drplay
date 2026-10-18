/**
 * Player command registry — the SINGLE source of truth for keyboard shortcuts
 * and (for the D2b menu) the action + label surface. Every key handling that
 * used to live in per-component window listeners (PlayerBar transport,
 * VolumeSlider, SeekBar, NowPlaying overlay) is routed here so exactly one
 * keydown listener exists and the shortcut/label/action of a command can never
 * drift apart across surfaces.
 *
 * Escape is deliberately NOT a command: the NowPlaying overlay owns its
 * layering (fullscreen -> overlay) in useNowPlayingShortcuts.
 *
 * The implementation lives in `commands/`: ids.ts holds the vocabulary and the
 * command shapes, definitions.ts the command table, registry.ts the lookup /
 * shortcut resolution. This file only re-exports the public surface so every
 * existing import path keeps working.
 */

export { PLAYER_COMMAND_IDS } from "./commands/ids";
export type {
  PlayerCommand,
  PlayerCommandContext,
  PlayerCommandId,
} from "./commands/ids";
export { VOLUME_STEP, VIDEO_ZOOM_STEP } from "./commands/definitions";
export {
  commandById,
  findCommandForEvent,
  PLAYER_COMMANDS,
  shortcutFor,
} from "./commands/registry";
