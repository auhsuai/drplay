import { afterEach, describe, expect, it, vi } from "vitest";
import { createSemaphore, sleep } from "./asyncLimit";

afterEach(() => {
  vi.useRealTimers();
});

describe("createSemaphore", () => {
  it("never runs more than maxConcurrent tasks at once", async () => {
    const sem = createSemaphore(2);
    const gates: Array<() => void> = [];
    let running = 0;
    let peak = 0;

    const tasks = Array.from({ length: 5 }, () =>
      sem.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        running -= 1;
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    expect(running).toBe(2);

    while (gates.length > 0) {
      const open = gates.shift();
      open?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(tasks);

    expect(running).toBe(0);
    expect(peak).toBe(2);
  });

  it("drains queued tasks in FIFO order", async () => {
    const sem = createSemaphore(1);
    const order: Array<number> = [];
    const gates: Array<() => void> = [];

    const tasks = [0, 1, 2, 3].map((i) =>
      sem.run(async () => {
        order.push(i);
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
      }),
    );

    await Promise.resolve();
    expect(order).toEqual([0]);

    while (gates.length > 0) {
      const open = gates.shift();
      open?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(tasks);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("double release never drives the active count negative", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire();
    expect(sem.active).toBe(1);
    release();
    expect(sem.active).toBe(0);
    release();
    expect(sem.active).toBe(0);
  });

  it("releases the slot when the task rejects", async () => {
    const sem = createSemaphore(1);
    await expect(
      sem.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(sem.active).toBe(0);

    await expect(sem.run(() => Promise.resolve(42))).resolves.toBe(42);
    expect(sem.active).toBe(0);
  });

  it("a rejecting task does not block queued tasks", async () => {
    const sem = createSemaphore(1);
    const first = sem.run(() => Promise.reject(new Error("boom")));
    const second = sem.run(() => Promise.resolve("ok"));
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });

  it("rejects maxConcurrent below 1", () => {
    expect(() => createSemaphore(0)).toThrow(TypeError);
    expect(() => createSemaphore(-1)).toThrow(TypeError);
  });
});

describe("sleep", () => {
  it("resolves only after the requested delay (fake timers)", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const waited = sleep(1_000).then(done);

    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await waited;
    expect(done).toHaveBeenCalledTimes(1);
  });
});
