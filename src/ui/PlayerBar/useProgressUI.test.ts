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

function shouldCorrect(diff: number, count: number): boolean {
  const THRESHOLD = 2.5;
  const MAX_CORRECT = 2;
  return diff > THRESHOLD && count < MAX_CORRECT;
}

describe('seek correction', () => {
  it('corrects only when diff large and under limit', () => {
    expect(shouldCorrect(3, 0)).toBe(true);
    expect(shouldCorrect(0.5, 0)).toBe(false);
    expect(shouldCorrect(3, 2)).toBe(false);
  });
});
