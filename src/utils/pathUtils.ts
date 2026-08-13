// Shared path helpers for the upload flows (diskFs, uploadManager,
// UploadButton, DropZone). Before this module, the exact same basename body
// was copy-pasted in 4 places — edge cases (trailing separators, root paths)
// now live in ONE tested spot.

const TRAILING_SEPARATORS = /[\\/]+$/;
const SEPARATOR_SPLIT = /[\\/]/;

/**
 * Extract the final path segment, supporting both `\` and `/` separators —
 * Tauri file-dialog paths (Windows `\`) and Drive-API relative paths (`/`)
 * both flow through here.
 *
 * Trailing separators are stripped first so a root path yields its folder
 * name instead of "": "C:\Music\" -> "Music", "C:\" -> "C:".
 *
 * The `?? path` fallback is unreachable (split always yields >= 1 part) but
 * is preserved verbatim from the original 4 copies to keep behavior
 * byte-identical.
 */
export function basename(path: string): string {
  const trimmed = path.replace(TRAILING_SEPARATORS, "");
  const parts = trimmed.split(SEPARATOR_SPLIT);
  return parts[parts.length - 1] ?? path;
}

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
