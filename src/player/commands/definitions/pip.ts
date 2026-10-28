import { PLAYER_COMMAND_IDS, type PlayerCommand } from "../ids";

export const PIP_COMMANDS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_PIP_TOGGLE,
    labelKey: "player.command.picture_in_picture",
    shortcut: "Ctrl+P",
    preventDefault: true,
    // Ctrl-only on purpose, NOT `commandModifier`: that helper also accepts
    // metaKey, and Meta+P is asserted to stay unbound (see commands.test.ts —
    // the app/webview owns the Cmd chords). Ctrl is also what keeps this
    // disjoint from PLAYER_PREVIOUS, whose matcher is `noModifiers` + "p".
    match: (e) =>
      e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "p",
    run: (ctx) => {
      // Direction lives in App (it owns isPipActive); the command stays a
      // single, optional delegation so a context without PiP is a no-op.
      ctx.togglePip?.();
    },
  },
];
