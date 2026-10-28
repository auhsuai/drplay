import { invoke } from "@tauri-apps/api/core";
import { describeError } from "./shared";

/**
 * Native surface hand-off outcomes (contract shared with Rust).
 *
 * `retargeted` is the ONLY success: the surface presents in the requested
 * window. The two failure-but-known states exist because a failed switch is not
 * the same thing as a lost picture:
 *  - `rolled_back` — the new target could not be created, but the PREVIOUS one
 *    was recreated, so that window still owns a working pipeline (honestly
 *    `healthy` from the user's point of view);
 *  - `detached` — no presentation pipeline exists at all (new target and the
 *    rollback both failed, or there was no previous target).
 */
export type PipRetargetOutcome = "retargeted" | "rolled_back" | "detached";

/**
 * Normalized result of one hand-off. `unresolved` deliberately exists: a
 * rejected IPC (5s timeout, render thread stopped, hwnd 0, transition already
 * in progress) says NOTHING about whether the native switch happened. Treating
 * a rejection as "the old window still owns it" (or as success) would be a
 * guess, and guessing here is exactly how the surface gets stranded.
 */
export type PipHandoffResult =
  | { kind: "retargeted" }
  | { kind: "rolled_back" }
  | { kind: "detached" }
  | { kind: "unresolved"; reason: string };

const RETARGET_COMMANDS = {
  toMain: "video_surface_retarget_to_main_cmd",
  toPip: "video_surface_retarget_to_pip_cmd",
} as const;

/** Readable form of an unknown resolved value, for the `unresolved` reason. */
function stringifyOutcome(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    // `JSON.stringify` answers `undefined` for undefined/functions/symbols, so
    // the fallback is a real branch rather than a defensive one.
    const json: unknown = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    // BigInt / circular payloads: the shape is only ever used in a log line.
    return String(value);
  }
}

/**
 * The string union is VALIDATED, never cast. Rust is the other half of this
 * contract and may grow a new variant (or fan out an old one) before this
 * side is updated; a blind cast would silently turn such a value into one of
 * three kinds the controller then acts on. Anything unrecognised is
 * `unresolved`, which every caller treats as "do not claim ownership".
 */
function parseOutcome(value: unknown): PipHandoffResult {
  if (
    value === "retargeted" ||
    value === "rolled_back" ||
    value === "detached"
  ) {
    return { kind: value };
  }
  return {
    kind: "unresolved",
    reason: `unexpected retarget outcome: ${stringifyOutcome(value)}`,
  };
}

/**
 * One command, one attempt, never throws: rejection becomes `unresolved` with
 * the error message attached so the caller can log a real reason. No retry
 * here on purpose — the guard in `usePipController` is what makes a retry a
 * user action ("Close again"), and an automatic retry of a transition-scoped
 * native call would just re-enter the same "transition in progress" rejection.
 */
async function handoff(command: string): Promise<PipHandoffResult> {
  try {
    return parseOutcome(await invoke<unknown>(command));
  } catch (error) {
    return { kind: "unresolved", reason: describeError(error) };
  }
}

/** Ask the native side to present the surface in the main window. */
export function handoffSurfaceToMain(): Promise<PipHandoffResult> {
  return handoff(RETARGET_COMMANDS.toMain);
}

/** Ask the native side to present the surface in the PiP window. */
export function handoffSurfaceToPip(): Promise<PipHandoffResult> {
  return handoff(RETARGET_COMMANDS.toPip);
}
