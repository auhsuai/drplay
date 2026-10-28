/**
 * Constants of the builder layer only — NOT the menu id vocabulary (that is
 * `../constants.ts`). `SEPARATOR_ENTRY` is kept as one identity so every
 * submenu and the full menu share the same separator entry.
 */
import type { NativeMenuEntry } from "../../../lib/nativeMenu";

export const SEPARATOR_ENTRY: NativeMenuEntry = { kind: "separator" };
