import { describe, it, expect, vi } from 'vitest';
import { runWithConcurrencyLimit } from './streamPrefetcher';

// Real coverage for the app's one concurrency-limiter implementation, used
// by prefetchVisibleTracks() to bound how many `get_stream_url` IPC calls
// run at once. Replaces metadata.concurrency.test.ts, which tested an
// unrelated hand-rolled class defined inline in the test file itself and
// never imported anything from production code.
describe('runWithConcurrencyLimit', () => {
  it('never runs more than `limit` items concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await runWithConcurrencyLimit(items, 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('processes every item exactly once', async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];

    await runWithConcurrencyLimit(items, 2, async (item) => {
      seen.push(item);
    });

    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('resolves successfully even when some items throw (never rejects the whole batch)', async () => {
    const items = [1, 2, 3, 4];
    const succeeded: number[] = [];

    await expect(
      runWithConcurrencyLimit(items, 2, async (item) => {
        if (item % 2 === 0) throw new Error(`item ${item} failed`);
        succeeded.push(item);
      })
    ).resolves.toBeUndefined();

    expect(succeeded.sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('does not block on a slow item once the limit frees up for the next one', async () => {
    const order: string[] = [];

    await runWithConcurrencyLimit(['slow', 'fast', 'fast2'], 2, async (item) => {
      const delay = item === 'slow' ? 20 : 1;
      await new Promise((r) => setTimeout(r, delay));
      order.push(item);
    });

    // 'fast' starts alongside 'slow' (limit=2) and finishes first; 'fast2'
    // only starts once a slot frees, but since both fast items are quick
    // it should still land before 'slow'. This mainly asserts all three
    // eventually complete without the slow item deadlocking the batch.
    expect(order).toContain('slow');
    expect(order).toContain('fast');
    expect(order).toContain('fast2');
    expect(order.length).toBe(3);
  });

  it('handles an empty item list without hanging', async () => {
    const fn = vi.fn();
    await runWithConcurrencyLimit([], 5, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
