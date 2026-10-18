import { COMMAND_DEFINITIONS } from "./definitions";
import type { PlayerCommand, PlayerCommandId } from "./ids";

function isEditableFocus(): boolean {
  const activeEl = document.activeElement as HTMLElement | null;
  return (
    activeEl?.tagName === "INPUT" ||
    activeEl?.tagName === "TEXTAREA" ||
    activeEl?.isContentEditable === true
  );
}

export const PLAYER_COMMANDS: readonly PlayerCommand[] = COMMAND_DEFINITIONS;

const COMMANDS_BY_ID = new Map<PlayerCommandId, PlayerCommand>(
  COMMAND_DEFINITIONS.map((command) => [command.id, command]),
);

export function commandById(id: PlayerCommandId): PlayerCommand {
  const command = COMMANDS_BY_ID.get(id);
  if (!command) throw new Error(`Unknown player command id: ${id}`);
  return command;
}

export function shortcutFor(id: PlayerCommandId): string {
  return commandById(id).shortcut;
}

/**
 * Resolve the command for a keydown, or undefined when none applies.
 * Guards, in order: editable focus swallows everything; the first matching
 * command wins (matchers are disjoint); non-repeatable commands drop held-key
 * repeats (seek/volume/speed/delay/zoom opt in).
 */
export function findCommandForEvent(
  event: KeyboardEvent,
): PlayerCommand | undefined {
  if (isEditableFocus()) return undefined;
  for (const command of COMMAND_DEFINITIONS) {
    if (!command.match(event)) continue;
    if (event.repeat && command.repeatable !== true) return undefined;
    return command;
  }
  return undefined;
}
