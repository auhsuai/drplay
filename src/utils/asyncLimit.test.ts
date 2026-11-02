import { describe, expect, it } from "vitest";
import { createSemaphore } from "./asyncLimit";

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

  it("reports the queued waiter count", async () => {
    const sem = createSemaphore(1);
    const first = sem.run(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    );
    const second = sem.run(() => Promise.resolve());
    expect(sem.pending).toBe(1);
    await Promise.all([first, second]);
    expect(sem.pending).toBe(0);
  });
});

// ---- Phase A5: abort-aware queue -------------------------------------------
describe("createSemaphore cancellation", () => {
  it("a task aborted while QUEUED never dispatches and never takes a slot", async () => {
    const sem = createSemaphore(1);
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = sem.run(() => holdFirst);

    const controller = new AbortController();
    let dispatched = false;
    const queued = sem.run(() => {
      dispatched = true;
      return Promise.resolve("ran");
    }, controller.signal);
    expect(sem.pending).toBe(1);

    controller.abort();
    await expect(queued).rejects.toBeDefined();
    expect(sem.pending).toBe(0);
    expect(sem.active).toBe(1); // only the first task holds a slot

    releaseFirst();
    await first;
    expect(dispatched).toBe(false); // the aborted task never ran
    expect(sem.active).toBe(0);
  });

  it("an aborted queued task cannot delay a live task behind it", async () => {
    const sem = createSemaphore(1);
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = sem.run(async () => {
      order.push("first");
      await holdFirst;
    });
    const controller = new AbortController();
    const doomed = sem.run(() => {
      order.push("doomed");
      return Promise.resolve();
    }, controller.signal);
    const live = sem.run(() => {
      order.push("live");
      return Promise.resolve();
    });
    controller.abort();
    await expect(doomed).rejects.toBeDefined();
    releaseFirst();
    await first;
    await live;
    expect(order).toEqual(["first", "live"]);
  });

  it("an already-aborted signal rejects immediately without touching the queue", async () => {
    const sem = createSemaphore(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      sem.run(() => Promise.resolve("never"), controller.signal),
    ).rejects.toBeDefined();
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);
  });

  it("releases every acquired slot exactly once on all paths", async () => {
    const sem = createSemaphore(2);
    await Promise.all([
      sem.run(() => Promise.resolve()),
      sem
        .run(() => {
          throw new Error("sync throw");
        })
        .catch(() => undefined),
      sem
        .run(() => Promise.reject(new Error("async reject")))
        .catch(() => undefined),
      sem.run(() => Promise.resolve("ok")),
    ]);
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);
  });

  it("acquire() aborted while queued removes the waiter (no phantom slot)", async () => {
    const sem = createSemaphore(1);
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = sem.acquire();
    const controller = new AbortController();
    const second = sem.acquire(controller.signal);
    controller.abort();
    await expect(second).rejects.toBeDefined();
    const release = await first;
    expect(sem.pending).toBe(0);
    release();
    expect(sem.active).toBe(0);
    releaseFirst();
    await holdFirst;
  });

  it("a cancelled task that already acquired its slot releases it (no leak)", async () => {
    const sem = createSemaphore(1);
    const controller = new AbortController();
    const task = sem.run(async () => {
      controller.abort(); // cancel INSIDE the task, after acquiring
      await Promise.resolve();
      return "done";
    }, controller.signal);
    await expect(task).resolves.toBe("done");
    expect(sem.active).toBe(0);
  });
});
