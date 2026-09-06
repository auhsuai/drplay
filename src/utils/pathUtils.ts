/**
 * Strip the final extension (the last dot and everything after it) from a
 * name. Single source of truth for both useDriveListing (file titles) and
 * the metadata pipeline (placeholder titles) — the two previously diverged
 * on names containing both a dot and a slash. Slash can never appear inside
 * a Drive file name (it is the path separator), so the simpler "last dot"
 * semantics is safe for both callers.
 */
export function stripAudioExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
