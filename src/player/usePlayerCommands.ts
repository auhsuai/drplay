import { useEffect, useRef } from "react";
import { describeError } from "../lib/mpvProtocol";
import { showErrorToast } from "../utils/simpleToast";
import {
  commandById,
  findCommandForEvent,
  type PlayerCommandContext,
  type PlayerCommandId,
} from "./commands";

/**
 * Mount the SINGLE global player-keydown listener. The context is kept in a
 * ref (updated after every render) so the listener attaches exactly once while
 * still running the freshest App callbacks.
 */
export function usePlayerCommands(context: PlayerCommandContext): void {
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const command = findCommandForEvent(event);
      if (!command) return;
      if (command.preventDefault) event.preventDefault();
      runPlayerCommand(command.id, contextRef.current);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}

/**
 * Shared entry point for button/menu callers (PlayerBar, D2b menu) so they run
 * the exact same command implementation as the keyboard path. Failures are
 * surfaced as an error toast — with the operation context the mpvControl
 * wrappers carry — and never swallowed.
 */
export function runPlayerCommand(
  id: PlayerCommandId,
  ctx: PlayerCommandContext,
): void {
  // Activity FIRST, and exactly once, before the command runs: this is the one
  // seam every surface (keyboard, bar button, context menu) goes through, so
  // the fullscreen chrome reveals without a second listener and without the
  // command itself ever being delayed, swallowed or duplicated.
  ctx.onActivity?.();
  const command = commandById(id);
  void (async () => {
    try {
      await command.run(ctx);
    } catch (e: unknown) {
      showErrorToast(describeError(e));
    }
  })();
}
