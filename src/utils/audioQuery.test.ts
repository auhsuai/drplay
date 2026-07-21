import { describe, it, expect } from 'vitest';
import { AUDIO_EXTENSIONS, hasAudioExtension, isAudioFile, getAudioQuery, getFolderAudioQuery, getAudioFilesQuery } from './audioQuery';

describe('hasAudioExtension', () => {
  it('matches a known audio extension case-insensitively', () => {
    expect(hasAudioExtension('Song.MP3')).toBe(true);
    expect(hasAudioExtension('track.flac')).toBe(true);
  });

  it('does not match a non-audio extension', () => {
    expect(hasAudioExtension('notes.txt')).toBe(false);
    expect(hasAudioExtension('cover.jpg')).toBe(false);
  });
});

describe('isAudioFile', () => {
  it('returns true when the mimeType contains audio/', () => {
    expect(isAudioFile('audio/mpeg', 'whatever.bin')).toBe(true);
  });

  it('falls back to extension match when mimeType is missing/generic', () => {
    expect(isAudioFile('application/octet-stream', 'song.flac')).toBe(true);
    expect(isAudioFile(undefined, 'song.flac')).toBe(true);
  });

  it('returns false for a non-audio mimeType and non-audio name', () => {
    expect(isAudioFile('text/plain', 'notes.txt')).toBe(false);
  });
});

// Regression coverage for the real drift this audit found: getAudioQuery()'s
// extension-fallback branch was missing the `mimeType='application/octet-stream'`
// guard that getFolderAudioQuery()/getAudioFilesQuery() both already have,
// so it matched ANY file whose name merely *contains* an audio-extension
// substring (e.g. "notes.mp3.txt") regardless of real mimeType. This feeds
// the full-library background sync (proSync.worker.ts), so the drift could
// have pulled non-audio files into the synced library.
describe('getAudioQuery', () => {
  it('guards every extension-fallback condition with the octet-stream mimeType check', () => {
    const query = getAudioQuery();
    for (const ext of AUDIO_EXTENSIONS) {
      expect(query).toContain(`(mimeType='application/octet-stream' and name contains '${ext}')`);
    }
  });

  it('still matches folders and anything Drive already tags as audio/*', () => {
    const query = getAudioQuery();
    expect(query).toContain("mimeType='application/vnd.google-apps.folder'");
    expect(query).toContain("mimeType contains 'audio/'");
  });

  it('excludes trashed items', () => {
    expect(getAudioQuery()).toContain('trashed=false');
  });
});

// Guards against this exact 3-way drift recurring: all three query builders
// answer the same conceptual question ("is this Drive item audio, using the
// filename extension as a fallback when Drive can't sniff the mimeType") and
// must apply the mimeType guard identically on their extension-fallback branch.
describe('extension-fallback guard consistency across all three query builders', () => {
  it('getAudioQuery, getFolderAudioQuery, and getAudioFilesQuery all require the same octet-stream guard per extension', () => {
    const queries = [getAudioQuery(), getFolderAudioQuery('some-folder-id'), getAudioFilesQuery()];
    for (const query of queries) {
      for (const ext of AUDIO_EXTENSIONS) {
        expect(query).toContain(`(mimeType='application/octet-stream' and name contains '${ext}')`);
      }
    }
  });
});
