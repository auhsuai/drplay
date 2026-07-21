// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

class ConcurrencyQueue {
  private queue: (() => void)[] = [];
  private activeCount = 0;
  constructor(private concurrency: number) {}
  async enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Promise((resolve, reject) => {
      const run = async () => {
        if (signal?.aborted) {
          this.activeCount--;
          this.dequeue();
          return reject(new DOMException("Aborted", "AbortError"));
        }
        try {
          resolve(await task());
        } catch (e) {
          reject(e);
        } finally {
          this.activeCount--;
          this.dequeue();
        }
      };
      if (this.activeCount < this.concurrency) {
        this.activeCount++;
        run();
      } else {
        this.queue.push(run);
      }
    });
  }
  private dequeue() {
    if (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const next = this.queue.shift();
      if (next) {
        this.activeCount++;
        next();
      }
    }
  }
}

describe('ConcurrencyQueue deadlock', () => {
  it('blocks all subsequent tasks when all slots are occupied by hanging tasks', async () => {
    const queue = new ConcurrencyQueue(2);

    const hangingTask = () => new Promise<string>(() => {});

    const fastTask = () => Promise.resolve('done');

    void queue.enqueue(hangingTask);

    let secondResolved = false;
    void queue.enqueue(hangingTask).then(() => { secondResolved = true; });

    let thirdResolved = false;
    void queue.enqueue(fastTask).then(() => { thirdResolved = true; });

    await new Promise(r => setTimeout(r, 100));
    expect(secondResolved).toBe(false);
    expect(thirdResolved).toBe(false);
  });

  it('direct calls (no queue) process independently even when some tasks hang', async () => {
    const hangingTask = () => new Promise<string>(() => {});

    const fastTask = () => Promise.resolve('done');

    void hangingTask();
    void hangingTask();

    const fastResult = await fastTask();
    expect(fastResult).toBe('done');
  });
});
