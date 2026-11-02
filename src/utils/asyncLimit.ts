/**
 * Shared concurrency primitives used across modules that throttle app-wide
 * network work (range fetches, cover POSTs):
 * - createSemaphore(maxConcurrent): runs at most `maxConcurrent` tasks at a
 *   time, draining queued tasks FIFO as slots free up.
 *
 * Cancellation contract (Phase A5):
 * - `acquire(signal)` rejects with the signal's reason when the caller aborts
 *   while WAITING for a slot, and removes the waiter from the queue — an
 *   aborted task never consumes a slot, so it cannot delay live work.
 * - `run(task, signal)` never invokes `task` after cancellation: an aborted
 *   waiter rejects before dispatch (the task is skipped entirely).
 * - Every acquired slot is released exactly once on every path (resolve,
 *   reject, throw, cancel). `release()` is idempotent per acquisition.
 * - The semaphore does NOT add a timeout: queue wait is bounded only by the
 *   callers' own abort signals (documented per call site; see
 *   driveRangeChunkFetcher for the metadata timeout scope).
 */

export interface SemaphoreAcquireOptions {
  /**
   * Optional cancellation. When it aborts while the caller is QUEUED, the
   * waiter is removed and the promise rejects with `signal.reason`. An
   * already-aborted signal rejects immediately without touching the queue.
   */
  signal?: AbortSignal;
}

export interface Semaphore {
  /** Runs `task` once a slot is free. The slot is always released after the
   *  task settles, whether it resolves or rejects. When `signal` aborts while
   *  queued, the task is never invoked. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Waits for a slot and returns the release function for it. */
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** Number of tasks currently holding a slot. */
  readonly active: number;
  /** Number of tasks currently waiting for a slot. */
  readonly pending: number;
}

interface Waiter {
  /** Grants the slot to this waiter. */
  resolve: (release: () => void) => void;
  /** Rejects the waiter (cancelled while queued). */
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  /** Detaches the waiter's abort listener; called on every settlement path. */
  cleanup: () => void;
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  if (typeof maxConcurrent !== "number" || maxConcurrent < 1) {
    throw new TypeError(
      `Expected maxConcurrent to be a number from 1 and up, got \`${String(maxConcurrent)}\``,
    );
  }
  let active = 0;
  const waiters: Waiter[] = [];

  function makeRelease(): () => void {
    let released = false;
    return () => {
      // Exactly-once guard: a stray second release must never free a slot
      // that another task holds (the old Math.max(0, active-1) clamp silently
      // stole a slot from a concurrent task).
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      pump();
    };
  }

  function removeWaiter(waiter: Waiter): boolean {
    const index = waiters.indexOf(waiter);
    if (index === -1) return false;
    waiters.splice(index, 1);
    return true;
  }

  function pump(): void {
    while (active < maxConcurrent && waiters.length > 0) {
      const next = waiters.shift();
      if (!next) continue;
      next.cleanup();
      active += 1;
      next.resolve(makeRelease());
    }
  }

  function acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      // Reject with the caller's own reason verbatim (AbortSignal.reason is
      // intentionally `any` per DOM; the contract is to propagate it as-is).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(signal.reason);
    }
    if (active < maxConcurrent && waiters.length === 0) {
      active += 1;
      return Promise.resolve(makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        cleanup: () => {
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = (): void => {
        // Queued-cancel path: drop the waiter so it never consumes a slot.
        if (!removeWaiter(waiter)) return; // already granted — caller owns it
        waiter.cleanup();
        // Same verbatim-reason contract as the pre-aborted path above.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal?.reason);
      };
      waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const releaseSlot = await acquire(signal);
      // A signal that aborted in the microtask between resolution and this
      // line still must not dispatch the task: release and bail out.
      if (signal?.aborted === true) {
        releaseSlot();
        throw signal.reason as unknown;
      }
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
    get pending(): number {
      return waiters.length;
    },
  };
}
