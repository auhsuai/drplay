export const AUDIO_EXTENSIONS = [
  '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus',
  '.wma', '.aiff', '.alac', '.ape', '.dsf', '.dff', '.wv', '.tak'
];

export function hasAudioExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function isAudioFile(mimeType: string | undefined, name: string): boolean {
  if (mimeType?.includes('audio/')) return true;
  return hasAudioExtension(name);
}

export function getAudioQuery(): string {
  // Was missing the `mimeType='application/octet-stream'` guard its two
  // siblings below both have on their extension-fallback branch, so this
  // matched ANY file whose name merely contains an audio-extension
  // substring (e.g. "notes.mp3.txt"), regardless of actual mimeType. This
  // query feeds the full-library background sync (proSync.worker.ts), so
  // the drift could pull non-audio files into the synced library.
  const extConditions = AUDIO_EXTENSIONS
    .map(ext => `(mimeType='application/octet-stream' and name contains '${ext}')`)
    .join(' or ');
  return `trashed=false and (mimeType='application/vnd.google-apps.folder' or mimeType contains 'audio/' or ${extConditions})`;
}

export function getFolderAudioQuery(folderId: string): string {
  const extConditions = AUDIO_EXTENSIONS
    .map(ext => `(mimeType='application/octet-stream' and name contains '${ext}')`)
    .join(' or ');
  return `'${folderId}' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or mimeType contains 'audio/' or ${extConditions})`;
}

export function getAudioFilesQuery(): string {
  const extConditions = AUDIO_EXTENSIONS
    .map(ext => `(mimeType='application/octet-stream' and name contains '${ext}')`)
    .join(' or ');
  return `trashed=false and (mimeType contains 'audio/' or ${extConditions})`;
}
