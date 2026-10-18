import i18next from "i18next";
import type { MpvTrack } from "../../lib/mpvControl";
import type { NativeMenuEntry } from "../../lib/nativeMenu";
import {
  PLAYER_COMMAND_IDS,
  commandById,
  type PlayerCommandId,
} from "../commands";
import { formatTrackLabel } from "./labels";
import type { VideoMenuSnapshot } from "./snapshot";

// ---------------------------------------------------------------------------
// Entry constructors
// ---------------------------------------------------------------------------

interface MenuItemFields {
  id: string;
  label: string;
  shortcut?: string;
  enabled?: boolean;
  checked?: boolean;
  children?: NativeMenuEntry[];
  /** DrPlay-only right-aligned hint; see NativeMenuItem.detail. */
  detail?: string | undefined;
}

/** One place that turns optional fields into an exactOptionalPropertyTypes-safe item. */
export function menuItem(fields: MenuItemFields): NativeMenuEntry {
  return {
    kind: "item",
    id: fields.id,
    label: fields.label,
    ...(fields.shortcut !== undefined ? { shortcut: fields.shortcut } : {}),
    ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {}),
    ...(fields.checked !== undefined ? { checked: fields.checked } : {}),
    ...(fields.children !== undefined ? { children: fields.children } : {}),
    ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
  };
}

/** A leaf that runs a registry command — label/shortcut can never drift. */
export function commandEntry(
  id: PlayerCommandId,
  overrides: { label?: string; checked?: boolean } = {},
): NativeMenuEntry {
  const command = commandById(id);
  return menuItem({
    id: command.id,
    label: overrides.label ?? translateCommandLabel(command.labelKey),
    ...(command.shortcut !== "" ? { shortcut: command.shortcut } : {}),
    ...(overrides.checked !== undefined ? { checked: overrides.checked } : {}),
  });
}

/**
 * The registry stores labelKey as a plain string (the literal lives at its
 * definition site in commands.ts), so the strict i18next key union cannot see
 * through the variable. The defaultValue overload is i18next's string-key
 * signature; a missing key then falls back to the key itself, like before.
 */
function translateCommandLabel(labelKey: string): string {
  return i18next.t(labelKey, { defaultValue: labelKey });
}

/** A leaf that reuses a command's label/shortcut but carries a `menu:*` id. */
export function menuCommandEntry(
  menuId: string,
  commandId: PlayerCommandId,
  checked?: boolean,
): NativeMenuEntry {
  const command = commandById(commandId);
  return menuItem({
    id: menuId,
    label: translateCommandLabel(command.labelKey),
    ...(command.shortcut !== "" ? { shortcut: command.shortcut } : {}),
    ...(checked !== undefined ? { checked } : {}),
  });
}

export function playPauseEntry(s: VideoMenuSnapshot): NativeMenuEntry {
  return commandEntry(PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE, {
    label: i18next.t(s.isPaused ? "player.play" : "player.pause"),
  });
}

export function fullscreenEntry(s: VideoMenuSnapshot): NativeMenuEntry {
  return commandEntry(PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN, {
    label: i18next.t(
      s.isFullscreen ? "player.exit_fullscreen" : "player.fullscreen",
    ),
  });
}

export function trackEntry(
  prefix: string,
  track: MpvTrack,
  fallback: string,
  checked: boolean,
): NativeMenuEntry {
  return menuItem({
    id: `${prefix}${String(track.id)}`,
    label: formatTrackLabel(track, fallback),
    checked,
  });
}
