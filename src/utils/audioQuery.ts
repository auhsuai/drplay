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

function buildExtCondition(octetStreamVariant: boolean): string {
  return PLAYABLE_AUDIO_EXTENSIONS.map((ext) =>
    octetStreamVariant
      ? `(name contains '${ext}' and (mimeType contains 'audio/' or mimeType='${OCTET_STREAM_MIME}'))`
      : `name contains '${ext}'`,
  ).join(" or ");
}

// The discriminator is the playable EXTENSION, not the mime type: a file
// without a playable extension must not sync even when Drive reports audio/*
// (a .wma file reports audio/x-ms-wma but WebView2 cannot decode WMA). The
// two variants are kept deliberately: folder/recent queries scope each
// playable extension on `audio/*` OR `application/octet-stream` (uploads made
// by this app store octet-stream; Drive web/uploads report audio/mpeg etc.),
// while the top-level library query matches any mime with a playable name.
function buildAudioCondition(
  includeFolders: boolean,
  octetStreamVariant: boolean,
): string {
  const ext = octetStreamVariant
    ? buildExtCondition(true)
    : `(${buildExtCondition(false)})`;
  return includeFolders ? `(mimeType='${FOLDER_MIME}' or ${ext})` : `(${ext})`;
}

export function hasAudioExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return PLAYABLE_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
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
  return `${TRASHED} and ${buildAudioCondition(true, false)}`;
}

export function getFolderAudioQuery(folderId: string): string {
  return `'${folderId}' in parents and ${TRASHED} and ${buildAudioCondition(true, true)}`;
}
