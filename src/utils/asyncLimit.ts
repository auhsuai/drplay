/**
 * Shared concurrency primitives used across modules that throttle app-wide
 * network work (range fetches, cover POSTs):
 * - createSemaphore(maxConcurrent): runs at most `maxConcurrent` tasks at a
 *   time, draining queued tasks FIFO as slots free up.
 * - sleep(ms): promise-based delay for retry backoff.
 */

export interface Semaphore {
  /** Runs `task` once a slot is free. The slot is always released after the
   *  task settles, whether it resolves or rejects. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Waits for a slot and returns the release function for it. */
  acquire(): Promise<() => void>;
  /** Number of tasks currently holding a slot. */
  readonly active: number;
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  if (typeof maxConcurrent !== "number" || maxConcurrent < 1) {
    throw new TypeError(
      `Expected maxConcurrent to be a number from 1 and up, got \`${String(maxConcurrent)}\``,
    );
  }
  let active = 0;
  const waiters: Array<() => void> = [];

  function pump(): void {
    while (active < maxConcurrent && waiters.length > 0) {
      const next = waiters.shift();
      if (next) {
        active += 1;
        next();
      }
    }
  }

  function release(): void {
    active = Math.max(0, active - 1);
    pump();
  }

  function acquire(): Promise<() => void> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve) => {
      waiters.push(() => {
        resolve(release);
      });
    });
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      const releaseSlot = await acquire();
      try {
        return await task();
      } finally {
        releaseSlot();
      }
    },
    acquire,
    get active(): number {
      return active;
    },
  };
}

/** Resolves after `ms` milliseconds (setTimeout-based). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
