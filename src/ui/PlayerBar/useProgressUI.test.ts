import { describe, it, expect } from 'vitest';
import { shouldApplySeekCorrection } from './useProgressUI';

describe('shouldApplySeekCorrection', () => {
  it('corrects when the seeked event arrives promptly but lands far from the target', () => {
    expect(shouldApplySeekCorrection({
      targetTime: 100,
      committedAtMs: 1000,
      nowMs: 1200, // 200ms later — clearly the same seek settling
      actualTime: 102.5, // 2.5s off, over the 1s threshold
    })).toBe(true);
  });

  it('does not correct when the seeked event lands close enough to the target', () => {
    expect(shouldApplySeekCorrection({
      targetTime: 100,
      committedAtMs: 1000,
      nowMs: 1200,
      actualTime: 100.4, // within the 1s threshold
    })).toBe(false);
  });

  it('does not correct a mismatched seeked event that arrives long after the commit', () => {
    // Regression test: this is the bug found from a user report of random
    // small auto-seeks during idle playback. A `seeked` event carries no
    // correlation id, so a stale target from an old/abandoned drag must NOT
    // be allowed to silently override an unrelated, much-later `.currentTime`
    // write (a track change, a retry/resume, etc.) just because it happens
    // to be the next `seeked` event to fire.
    expect(shouldApplySeekCorrection({
      targetTime: 100,
      committedAtMs: 1000,
      nowMs: 1000 + 10_000, // 10s later — the correction window (4s) has long passed
      actualTime: 250, // wildly different position (e.g. a different track entirely)
    })).toBe(false);
  });

  it('still corrects right at the edge of the window', () => {
    expect(shouldApplySeekCorrection({
      targetTime: 100,
      committedAtMs: 1000,
      nowMs: 1000 + 4000, // exactly at the default 4000ms window boundary
      actualTime: 105,
    })).toBe(true);
  });

  it('stops correcting just past the edge of the window', () => {
    expect(shouldApplySeekCorrection({
      targetTime: 100,
      committedAtMs: 1000,
      nowMs: 1000 + 4001, // 1ms past the boundary
      actualTime: 105,
    })).toBe(false);
  });

  it('respects a custom threshold/window when provided', () => {
    expect(shouldApplySeekCorrection({
      targetTime: 100,
      committedAtMs: 1000,
      nowMs: 1500,
      actualTime: 100.6,
      thresholdSec: 0.5,
    })).toBe(true);

    expect(shouldApplySeekCorrection({
      targetTime: 100,
      committedAtMs: 1000,
      nowMs: 3500,
      actualTime: 105,
      windowMs: 2000,
    })).toBe(false);
  });

  it('never corrects when the actual position exactly matches the target', () => {
    expect(shouldApplySeekCorrection({
      targetTime: 100,
      committedAtMs: 1000,
      nowMs: 1050,
      actualTime: 100,
    })).toBe(false);
  });
});
