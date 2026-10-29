import { FOLDER_MIME } from "./driveTypes";

// Playback is the shipped libmpv engine, not the WebView2/Chromium media
// stack: the decodable set is mpv's FFmpeg build, so Chromium's codec matrix
// is irrelevant here.
//
// The five appended formats (.wma, .aif/.aiff, .oga, .m4b) were verified at
// DECODER level with the shipped mpv.exe against real samples (exit 0 and a
// live AO line), and they travel the same localhost Range proxy + SW ?ext=
// lane as the original seven. That is decoder evidence, not an end-to-end run.
//
// .ape/.wv/.tak/.dsf/.dff stay absent as an EVIDENCE GAP — no sample has been
// played end to end yet — NOT because of a Chromium decoder limit.
//
// The extension is a container, never a codec guarantee: ALAC inside .m4a was
// separately confirmed decodable, so .m4a is not AAC-only.
export const PLAYABLE_AUDIO_EXTENSIONS = [
  ".mp3",
  ".flac",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".opus",
  ".wma",
  ".aif",
  ".aiff",
  ".oga",
  ".m4b",
] as const;

const TRASHED = "trashed=false";
const OCTET_STREAM_MIME = "application/octet-stream";

// Video containers mpv decodes from the SAME localhost Range proxy as audio.
// Every extension here was verified END TO END against a real Google Drive
// sample: discovered by the Drive query, classified as video, fetched through
// the real localhost Range proxy (HTTP 206) and rendered + played by the
// shipped mpv engine. .mkv/.mp4 additionally have in-repo transport evidence
// (probe.mkv / probe-faststart.mp4 / probe-frag.mp4).
//
// The verification is PER FILE / PER CODEC, not a guarantee about the
// container: a passing extension proves that one sample's container + codec
// combination works on this transport, NOT that the container is universally
// decodable (libavformat demux support is not decoder support — e.g. a VC-1
// .wmv may demux and still fail to decode). Never widen this list from a
// container name alone; a new sample needs its own end-to-end run.
//
// Widening this list also widens a Drive `name contains` substring query (see
// DRIVE_SUBSTRING_FALSE_POSITIVES below) — the collision table must be kept in
// sync with every extension enabled here, or `.avif` photos / `.tsx` sources
// start entering the library as playable rows.
export const PLAYABLE_VIDEO_EXTENSIONS = [
  ".mkv",
  ".mp4",
  ".webm",
  ".m4v",
  ".mov",
  ".avi",
  ".wmv",
  ".flv",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".3gp",
  ".vob",
  ".asf",
  ".ts",
] as const;

// Drive's `q` is `name contains '.ext'` — a SUBSTRING match anywhere in the
// name, case-insensitively — while the runtime predicate is String.endsWith.
// For the video containers above the two are not equivalent predicates: a
// longer name that merely contains the extension (photo.avif for '.avi',
// App.tsx for '.ts', rec.3gpp for '.3gp') would be listed as a playable video
// and then classified as audio. This table is the single source of truth for
// those collisions: the top-level video query emits one `not name contains`
// clause per entry and `isVideoNameNoise` mirrors the same data for ingest.
//
// Every entry names a DISTINCT suffix — never the extension itself (a real
// clip.ts must still match) — and never the generic `*.ext.bak/.part/.tmp`
// family (those are not videos and already fail the endsWith classification).
// A suffix must either ENCLOSE the extension (longer, e.g. '.avif' for '.avi')
// or share no trailing run with it ('3g2' vs '3gp'). The latter case is inert:
// it excludes nothing the extension clause had matched.
export const DRIVE_SUBSTRING_FALSE_POSITIVES: Readonly<
  Record<string, readonly string[]>
> = {
  ".avi": [".avif"],
  ".ts": [".tsx", ".d.ts", ".ts.map", ".tsv"],
  ".3gp": [".3gpp", ".3g2"],
  ".mpeg": [".mpeg4"],
  ".mpg": [".mpga"],
  ".mov": [".movie"],
  ".vob": [".vobs"],
  ".webm": [".webmanifest"],
};

/** The public part of a media-kind decision: which extensions, which mime scope. */
interface MediaScope {
  readonly extensions: readonly string[];
  readonly mimePrefix: string;
  readonly substringFalsePositives?:
    Readonly<Record<string, readonly string[]>> | undefined;
}

const AUDIO_SCOPE: MediaScope = {
  extensions: PLAYABLE_AUDIO_EXTENSIONS,
  mimePrefix: "audio/",
};

// Only the video scope carries substring hazards: every audio extension is
// matched by the same substring rule, but no audio extension is a prefix of a
// non-audio name in practice, and the audio clause is byte-frozen by tests.
const VIDEO_SCOPE: MediaScope = {
  extensions: PLAYABLE_VIDEO_EXTENSIONS,
  mimePrefix: "video/",
  substringFalsePositives: DRIVE_SUBSTRING_FALSE_POSITIVES,
};

// Top-level (mime-agnostic) name clause for one extension, with the known
// substring false positives of that extension excluded. Exported so the
// exclusion rendering is testable for an extension that is not enabled yet:
// the emitted shape must stay `(name contains '.ts' and not name contains
// '.tsx' and ...)`, never a bare `not name contains '.ts'` for the extension
// itself (a real clip.ts must still match).
export function buildNameOnlyClause(
  ext: string,
  falsePositives: Readonly<Record<string, readonly string[]>> | undefined,
): string {
  const excluded = falsePositives?.[ext] ?? [];
  if (excluded.length === 0) return `name contains '${ext}'`;
  const exclusions = excluded
    .map((suffix) => ` and not name contains '${suffix}'`)
    .join("");
  return `(name contains '${ext}'${exclusions})`;
}

function buildExtCondition(
  scope: MediaScope,
  octetStreamVariant: boolean,
): string {
  return scope.extensions
    .map((ext) =>
      octetStreamVariant
        ? `(name contains '${ext}' and (mimeType contains '${scope.mimePrefix}' or mimeType='${OCTET_STREAM_MIME}'))`
        : buildNameOnlyClause(ext, scope.substringFalsePositives),
    )
    .join(" or ");
}

// The discriminator is the playable EXTENSION, not the mime type: a file
// without a playable extension must not sync even when Drive reports audio/*
// or video/* (a bare `song` with audio/mpeg and an unverified container are
// both rejected). The two variants are kept deliberately: folder/recent
// queries scope each playable extension on `<kind>/*` OR
// `application/octet-stream` (uploads made by this app store octet-stream;
// Drive web/uploads report audio/mpeg, video/mp4, video/x-matroska etc.),
// while the top-level library query matches any mime with a playable name.
function buildMediaCondition(
  scope: MediaScope,
  includeFolders: boolean,
  octetStreamVariant: boolean,
): string {
  const ext = octetStreamVariant
    ? buildExtCondition(scope, true)
    : `(${buildExtCondition(scope, false)})`;
  return includeFolders ? `(mimeType='${FOLDER_MIME}' or ${ext})` : `(${ext})`;
}

export function hasAudioExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return PLAYABLE_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function hasVideoExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return PLAYABLE_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Runtime mirror of DRIVE_SUBSTRING_FALSE_POSITIVES: true when the name ends
// with a suffix that only matched a video extension through Drive's substring
// `contains` (index.d.ts for '.ts', photo.avif for '.avi'). Case-insensitive
// like hasVideoExtension. This is a name-level veto only — String.endsWith
// stays the classification authority, so a name is never promoted to video by
// this module.
export function isVideoNameNoise(name: string): boolean {
  const lower = name.toLowerCase();
  return Object.values(DRIVE_SUBSTRING_FALSE_POSITIVES).some((suffixes) =>
    suffixes.some((suffix) => lower.endsWith(suffix)),
  );
}

// Playable-extension-only, exactly like isAudioFile: a file is a video iff its
// name ends in a video extension. The mimeType parameter is kept for
// call-site symmetry with isAudioFile (delta sync passes Drive's mime) but is
// intentionally unused, for the same reason.
export function isVideoFile(
  _mimeType: string | undefined,
  name: string,
): boolean {
  return hasVideoExtension(name);
}

// Playable-extension-only: a file is audio iff its name ends in a playable
// extension. The mimeType parameter is kept for call-site stability (delta
// sync still passes Drive's mime) but is intentionally unused — audio/*
// alone no longer qualifies: a no-extension "song" with audio/mpeg and a
// container outside the allowlist both deliberately return false.
export function isAudioFile(
  _mimeType: string | undefined,
  name: string,
): boolean {
  return hasAudioExtension(name);
}

export function getAudioQuery(): string {
  return `${TRASHED} and ${buildMediaCondition(AUDIO_SCOPE, true, false)}`;
}

export function getFolderAudioQuery(folderId: string): string {
  return `'${folderId}' in parents and ${TRASHED} and ${buildMediaCondition(AUDIO_SCOPE, true, true)}`;
}

export function getVideoQuery(): string {
  return `${TRASHED} and ${buildMediaCondition(VIDEO_SCOPE, true, false)}`;
}

export function getFolderVideoQuery(folderId: string): string {
  return `'${folderId}' in parents and ${TRASHED} and ${buildMediaCondition(VIDEO_SCOPE, true, true)}`;
}

/**
 * Library query: audio OR video, in the same top-level shape as getAudioQuery
 * (mime-agnostic, folders included).
 *
 * This is the query the Drive library is populated from, so it MUST be the
 * union — an audio-only library query means .mkv/.mp4 never become rows, so
 * no movie can ever be selected and the whole feature is unreachable no
 * matter what the engine does. The audio clause is emitted first and is
 * byte-identical to getAudioQuery's, so the audio half of the result set is
 * unchanged by construction.
 */
export function getMediaQuery(): string {
  const ext = `(${buildExtCondition(AUDIO_SCOPE, false)} or ${buildExtCondition(VIDEO_SCOPE, false)})`;
  return `${TRASHED} and (mimeType='${FOLDER_MIME}' or ${ext})`;
}

/**
 * Folder listing query: audio OR video, in the same shape as
 * getFolderAudioQuery (each extension scoped on its kind's mime OR
 * application/octet-stream). Used by the browse path and the recursive
 * add-folder-to-queue walk, so a folder containing movies lists them.
 */
export function getFolderMediaQuery(folderId: string): string {
  const ext = `${buildExtCondition(AUDIO_SCOPE, true)} or ${buildExtCondition(VIDEO_SCOPE, true)}`;
  return `'${folderId}' in parents and ${TRASHED} and (mimeType='${FOLDER_MIME}' or ${ext})`;
}
