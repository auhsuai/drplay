import { hasAudioExtension, hasVideoExtension } from "./audioQuery";
import { PLAYABLE_VIDEO_EXTENSIONS } from "./audioQuery";

/** Literal media-kind values. Spelled as literals, not derived, so a consumer
 *  can compare against the wire/db value without importing this module. */
export const MEDIA_KIND_AUDIO = "audio";
export const MEDIA_KIND_VIDEO = "video";

/**
 * Media kind of a playable library item. Phase A adds video as a SECOND kind
 * beside audio; audio stays the default so every pre-existing Track behaves
 * exactly as before.
 */
export type MediaKind = typeof MEDIA_KIND_AUDIO | typeof MEDIA_KIND_VIDEO;

export { PLAYABLE_VIDEO_EXTENSIONS };

/**
 * Classify a Drive file by NAME into a media kind.
 *
 * The decision is an EXPLICIT video-extension allowlist
 * (`PLAYABLE_VIDEO_EXTENSIONS` — the single source of truth, owned by
 * audioQuery.ts next to the audio list), never a negative test like
 * `ext !== "mp3"`: a negative test would sweep in every container and typo the
 * app has never verified, and would make widening the audio list a silent
 * behavior change.
 *
 * Default for anything unrecognized is AUDIO, deliberately: audio is what
 * every existing Track is, so a file this phase has not classified keeps
 * today's exact behavior (mpv `video=no`, no video output) instead of opening
 * a video window for something that is not a video.
 *
 * Case-insensitive because Drive preserves the uploader's capitalization
 * (`.MKV` is a real Drive filename).
 */
export function classifyMediaKind(name: string): MediaKind {
  return hasVideoExtension(name) ? MEDIA_KIND_VIDEO : MEDIA_KIND_AUDIO;
}

/**
 * True when `name` is a playable item of EITHER kind. This is the predicate
 * the sync/browse/queue filters want: "may this file enter the library at
 * all", not "which kind is it".
 */
export function isPlayableMediaFile(name: string): boolean {
  return hasAudioExtension(name) || hasVideoExtension(name);
}
