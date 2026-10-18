import type { MpvTrack } from "../../lib/mpvControl";
import { MENU_LABEL_MAX_LENGTH } from "./constants";

const TRACK_LABEL_SEPARATOR = " — ";
const TRACK_LABEL_FORCED_SUFFIX = " (forced)";
const TRACK_LABEL_DEFAULT_SUFFIX = " (default)";
const LABEL_ELLIPSIS = "…";

export function truncateLabel(
  label: string,
  maxLength = MENU_LABEL_MAX_LENGTH,
): string {
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1)}${LABEL_ELLIPSIS}`;
}

/**
 * §24 track label: `<title> — <lang>` (fallback `Audio Track 2` etc.), plus
 * the forced/default suffixes, truncated to the label budget.
 */
export function formatTrackLabel(track: MpvTrack, fallback: string): string {
  const parts: string[] = [];
  if (track.title !== undefined && track.title !== "") parts.push(track.title);
  if (track.lang !== undefined && track.lang !== "") parts.push(track.lang);
  const base = parts.length > 0 ? parts.join(TRACK_LABEL_SEPARATOR) : fallback;
  const suffix = `${track.forced ? TRACK_LABEL_FORCED_SUFFIX : ""}${track.isDefault ? TRACK_LABEL_DEFAULT_SUFFIX : ""}`;
  return truncateLabel(`${base}${suffix}`);
}
