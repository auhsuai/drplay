import { captureError } from "../../utils/errorLog";

/** Shared sink for the PiP window's non-fatal failures. Kept in its own module
 *  because BOTH the sizing/I-O helpers and the lifecycle hooks report through
 *  it: putting it in either one would make that module import the other. */
export function logPipViewFailure(kind: string, error: unknown): void {
  void captureError({
    level: "warn",
    source: "PipWindowView",
    message: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
    kind,
  });
}
