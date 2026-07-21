import { describe, it, expect } from 'vitest';
import { shuffleQueuePinning } from './usePlayer';
import type { Track } from '../App';

function track(id: string, queueItemId?: string): Track {
  return { id, title: id, artist: '', streamUrl: '', queueItemId };
}

// Regression coverage for the real drift this audit found: 3 independent
// copies of "shuffle then pin the current track to the front" had drifted
// -- two matched the pinned track by `.id` alone, one matched by
// `.queueItemId` first. Since `queueItemId` exists specifically to
// disambiguate the same track `.id` appearing twice in a queue, the
// `.id`-only copies could pin the WRONG entry when a queue contained a
// duplicate track id (e.g. the same song added to a playlist twice).
describe('shuffleQueuePinning', () => {
  it('pins the matching track to the front', () => {
    const queue = [track('a'), track('b'), track('c')];
    const result = shuffleQueuePinning(queue, track('b'));
    expect(result[0].id).toBe('b');
    expect(result).toHaveLength(3);
  });

  it('prefers queueItemId match over id match when the pinned track has a queueItemId (duplicate-id regression)', () => {
    // Two entries share the same `.id` ("dup") but have distinct
    // queueItemIds -- exactly the scenario `queueItemId` exists to
    // disambiguate. Pinning the SECOND occurrence must not accidentally
    // pin the first one just because `.id` matches.
    const first = track('dup', 'qi-1');
    const second = track('dup', 'qi-2');
    const queue = [first, second, track('c')];

    const result = shuffleQueuePinning(queue, track('dup', 'qi-2'));

    expect(result[0].queueItemId).toBe('qi-2');
    // The other "dup" entry (qi-1) must still be present elsewhere in the
    // result, untouched -- proving it wasn't the one that got pinned.
    expect(result.some((t) => t.queueItemId === 'qi-1')).toBe(true);
    expect(result).toHaveLength(3);
  });

  it('falls back to id match when the pinned track has no queueItemId', () => {
    const queue = [track('a', 'qi-a'), track('b', 'qi-b'), track('c', 'qi-c')];
    const result = shuffleQueuePinning(queue, track('b'));
    expect(result[0].id).toBe('b');
    expect(result[0].queueItemId).toBe('qi-b'); // keeps the queue entry's own id
  });

  it('places an unmatched pinned track at the front and stamps a fresh queueItemId if it lacks one', () => {
    const queue = [track('a'), track('b')];
    const pinned = track('not-in-queue');
    const result = shuffleQueuePinning(queue, pinned);

    expect(result[0].id).toBe('not-in-queue');
    expect(result[0].queueItemId).toBeTruthy();
    expect(result).toHaveLength(3); // original 2 + the newly-pinned one
  });

  it('preserves an unmatched pinned track\'s existing queueItemId instead of overwriting it', () => {
    const queue = [track('a'), track('b')];
    const pinned = track('not-in-queue', 'already-has-one');
    const result = shuffleQueuePinning(queue, pinned);

    expect(result[0].queueItemId).toBe('already-has-one');
  });

  it('never loses or duplicates items from the original queue', () => {
    const queue = [track('a'), track('b'), track('c'), track('d')];
    const result = shuffleQueuePinning(queue, track('c'));

    expect(result.map((t) => t.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not mutate the input queue array', () => {
    const queue = [track('a'), track('b'), track('c')];
    const queueCopy = [...queue];
    shuffleQueuePinning(queue, track('b'));
    expect(queue).toEqual(queueCopy);
  });
});
