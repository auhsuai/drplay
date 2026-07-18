import { describe, it, expect } from 'vitest';

function isLossless(name: string): boolean {
  return /\.(flac|wav|aiff|alac)$/i.test(name);
}

describe('lossless detection', () => {
  it('detects flac and wav', () => {
    expect(isLossless('song.flac')).toBe(true);
    expect(isLossless('song.wav')).toBe(true);
    expect(isLossless('song.mp3')).toBe(false);
  });

  it('detects aiff and alac, case-insensitive', () => {
    expect(isLossless('track.AIFF')).toBe(true);
    expect(isLossless('track.ALAC')).toBe(true);
    expect(isLossless('track.WAV')).toBe(true);
    expect(isLossless('track.wave')).toBe(false);
    expect(isLossless('track.m4a')).toBe(false);
  });
});
