import { FOLDER_MIME } from "./driveTypes";

// Only formats Chromium/WebView2 can decode are playable in this app.
// Source of truth: chromium.org/audio-video ("Codec and Container Support" —
// audio codecs: FLAC, MP3, PCM variants, Vorbis, Opus; AAC limited to Chrome
// builds) + MDN Web audio codec guide (ALAC Chrome=No, MP3/FLAC/Opus/Vorbis
// Chrome=Yes, AAC Chrome=MP4-only). wma/aiff/alac/ape/dsf/dff/wv/tak are
// deliberately absent: Chromium's FFmpeg build has no decoder for them
// (Task 1 — hide-unplayable-formats plan).
export const PLAYABLE_AUDIO_EXTENSIONS = [
  ".mp3",
  ".flac",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".opus",
] as const;

const TRASHED = "trashed=false";
const OCTET_STREAM_MIME = "application/octet-stream";

// Video containers mpv decodes from the SAME localhost Range proxy as audio,
// verified end-to-end on the shipped sidecar (probe.mkv / probe.mp4 open and
// seek over HTTP 206). Deliberately exactly two: every other container stays
// out of the library until it is verified on the same transport.
export const PLAYABLE_VIDEO_EXTENSIONS = [".mkv", ".mp4"] as const;

/** The public part of a media-kind decision: which extensions, which mime scope. */
interface MediaScope {
  readonly extensions: readonly string[];
  readonly mimePrefix: string;
}

const AUDIO_SCOPE: MediaScope = {
  extensions: PLAYABLE_AUDIO_EXTENSIONS,
  mimePrefix: "audio/",
};

const VIDEO_SCOPE: MediaScope = {
  extensions: PLAYABLE_VIDEO_EXTENSIONS,
  mimePrefix: "video/",
};

function buildExtCondition(
  scope: MediaScope,
  octetStreamVariant: boolean,
): string {
  return scope.extensions
    .map((ext) =>
      octetStreamVariant
        ? `(name contains '${ext}' and (mimeType contains '${scope.mimePrefix}' or mimeType='${OCTET_STREAM_MIME}'))`
        : `name contains '${ext}'`,
    )
    .join(" or ");
}

// The discriminator is the playable EXTENSION, not the mime type: a file
// without a playable extension must not sync even when Drive reports audio/*
// or video/* (a .wma file reports audio/x-ms-wma but WebView2 cannot decode
// WMA). The two variants are kept deliberately: folder/recent queries scope
// each playable extension on `<kind>/*` OR `application/octet-stream`
// (uploads made by this app store octet-stream; Drive web/uploads report
// audio/mpeg, video/mp4, video/x-matroska etc.), while the top-level library
// query matches any mime with a playable name.
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
// non-playable .wma with audio/x-ms-wma both deliberately return false.
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
