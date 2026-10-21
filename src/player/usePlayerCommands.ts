import { useEffect, useRef } from "react";
import { describeError } from "../lib/mpvProtocol";
import { showErrorToast } from "../utils/simpleToast";
import {
  commandById,
  findCommandForEvent,
  type PlayerCommandContext,
  type PlayerCommandId,
} from "./commands";
import {
  listenForNativeReloadRequests,
  requestPlayerReload,
} from "./reloadPlayer";

/**
 * Browser reload chord: a PLAIN F5 and nothing else. Every variant
 * (Shift+F5, Ctrl+F5, Ctrl+R) is deliberately not a reload - the native
 * layer turns the browser accelerator set off, so those chords do nothing at
 * all. Plain "r" is the aspect-cycle command and must never be treated as a
 * reload.
 */
function isReloadShortcut(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  return event.key === "F5";
}

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
    // Capture phase: run BEFORE the command layer and before the editable-focus
    // guard. preventDefault is what stops WebView2's own F5 reload - the
    // custom flow must stop the native engine first (see reloadPlayer.ts).
    const handleReloadKeyDown = (event: KeyboardEvent): void => {
      if (!isReloadShortcut(event)) return;
      event.preventDefault();
      if (event.repeat) return;
      void requestPlayerReload();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keydown", handleReloadKeyDown, true);
    // WebView2 handles F5 as a browser accelerator in its own process;
    // the native layer blocks it and asks the page to run the SAME ordered
    // flow. One reload request is deduped by requestPlayerReload either way.
    const stopNativeRequests = listenForNativeReloadRequests();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keydown", handleReloadKeyDown, true);
      stopNativeRequests();
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
