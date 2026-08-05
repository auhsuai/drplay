// Middle truncation for long download paths (Windows / UNC / mixed separators).
// Keeps the beginning (drive + first folder) and the END of the path — the
// destination folder — replacing the middle with an ellipsis. The CSS class
// `truncate` stays as a final fallback for paths too short to truncate here.

/** Max visible characters before the path is middle-truncated. */
export const MAX_VISIBLE_CHARS = 40;

const ELLIPSIS = "\u2026";

/** Matches Windows `\` and POSIX `/` separators. */
const SEGMENT_SEPARATOR = /[\\/]/;

/**
 * Truncates a long path from the middle: keeps the first two segments and the
 * last (non-empty) segment, joins them with an ellipsis.
 *
 * Rules:
 * - paths at or below `maxChars` are returned untouched (no ellipsis);
 * - paths with 2 segments or fewer (e.g. `C:\`, `C:`, `/`) are never
 *   truncated, so the only meaningful segment can never be lost;
 * - the last segment always appears, even if it must be clipped at the
 *   `maxChars` budget (rare: a single folder name longer than ~32 chars).
 */
export function truncatePathMiddle(
  path: string,
  maxChars: number = MAX_VISIBLE_CHARS,
): string {
  if (typeof path !== "string") return "";
  if (path.length <= maxChars) return path;

  const parts = path.split(SEGMENT_SEPARATOR);

  // Index of the last non-empty segment (a trailing separator leaves an
  // empty tail segment, e.g. `C:\Users\` → ["C:", "Users", ""]).
  let lastIdx = parts.length - 1;
  while (lastIdx >= 0 && parts[lastIdx] === "") lastIdx -= 1;

  // Too few meaningful segments to truncate (drive root, bare segment, UNC root).
  if (lastIdx <= 1) return path;

  const sep = path.match(SEGMENT_SEPARATOR)?.[0] ?? "\\";

  // UNC paths start with two empty segments (`\\server\share\...`); keep
  // `\\server\share` as the prefix so the share name stays visible.
  const prefix =
    parts[0] === "" && parts[1] === ""
      ? sep +
        sep +
        parts
          .slice(2, 4)
          .filter((s) => s !== "")
          .join(sep)
      : parts.slice(0, 2).join(sep);

  const suffix = parts[lastIdx];
  if (suffix === undefined) return path;

  // The destination folder is the most important part: give it the whole
  // budget first, and only clip the prefix when the budget forces it. The
  // separator is kept on both sides of the ellipsis so `C:\Users\…\Music`
  // reads as a real path, not `C:\Users…Music`.
  const overhead = sep.length * 2 + ELLIPSIS.length;
  const suffixBudget = Math.min(
    suffix.length,
    Math.max(1, maxChars - overhead - prefix.length),
  );
  const shownSuffix = suffix.slice(0, suffixBudget);
  const prefixBudget = Math.max(1, maxChars - overhead - shownSuffix.length);
  const shownPrefix = prefix.slice(0, prefixBudget);

  return shownPrefix + sep + ELLIPSIS + sep + shownSuffix;
}
