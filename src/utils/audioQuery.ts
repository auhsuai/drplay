import { FOLDER_MIME } from './driveApi';

export const AUDIO_EXTENSIONS = [
  '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus',
  '.wma', '.aiff', '.alac', '.ape', '.dsf', '.dff', '.wv', '.tak'
] as const;

const TRASHED = 'trashed=false';
const AUDIO_MIME_PREFIX = 'audio/';
const OCTET_STREAM_MIME = 'application/octet-stream';

function buildExtCondition(octetStreamVariant: boolean): string {
  return AUDIO_EXTENSIONS
    .map(ext => octetStreamVariant
      ? `(mimeType='${OCTET_STREAM_MIME}' and name contains '${ext}')`
      : `name contains '${ext}'`)
    .join(' or ');
}

function buildAudioCondition(includeFolders: boolean, octetStreamVariant: boolean): string {
  const ext = octetStreamVariant ? buildExtCondition(true) : `(${buildExtCondition(false)})`;
  const mediaPart = `mimeType contains '${AUDIO_MIME_PREFIX}' or ${ext}`;
  return includeFolders
    ? `(mimeType='${FOLDER_MIME}' or ${mediaPart})`
    : `(${mediaPart})`;
}

export function hasAudioExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function isAudioFile(mimeType: string | undefined, name: string): boolean {
  if (mimeType?.includes('audio/')) return true;
  return hasAudioExtension(name);
}

export function getAudioQuery(): string {
  return `${TRASHED} and ${buildAudioCondition(true, false)}`;
}

export function getFolderAudioQuery(folderId: string): string {
  return `'${folderId}' in parents and ${TRASHED} and ${buildAudioCondition(true, true)}`;
}

export function getAudioFilesQuery(): string {
  return `${TRASHED} and ${buildAudioCondition(false, true)}`;
}
