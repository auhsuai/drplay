import { beforeEach, describe, expect, it, vi } from "vitest";

const captureErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/errorLog", () => ({ captureError: captureErrorMock }));

import { runBulkOperation, TRASH_MODULE } from "./trashBulkOps";

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runBulkOperation failure log format (P2-05-1)", () => {
  it("logs failures with the sanitizer-matching fileId= form and keeps the aggregation contract", async () => {
    const ids = ["abc123", "ok1"];
    const { succeededIds, failedCount } = await runBulkOperation(
      ids.map(
        (id) => () =>
          id === "abc123"
            ? Promise.reject(new Error("Drive 404"))
            : Promise.resolve(undefined),
      ),
      ids,
      "bulk-delete-item-failed",
    );

    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: TRASH_MODULE,
        message: "bulk-delete-item-failed for fileId=abc123: Drive 404",
      }),
    );
    expect([...succeededIds]).toEqual(["ok1"]);
    expect(failedCount).toBe(1);
  });

  it("stringifies non-Error rejection reasons after the fileId= prefix", async () => {
    const { failedCount } = await runBulkOperation(
      // Deliberately non-Error: the hook stringifies raw rejection reasons.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      [() => Promise.reject("drive exploded")],
      ["f9"],
      "empty-trash-item-failed",
    );

    expect(failedCount).toBe(1);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "empty-trash-item-failed for fileId=f9: drive exploded",
      }),
    );
  });
});

describe("runBulkOperation bounded concurrency (P2-05-2)", () => {
  it("keeps at most 5 tasks in flight and still settles every task", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `f${String(i)}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];

    const tasks = ids.map(
      () => () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight -= 1;
            resolve();
          });
        }),
    );

    const batch = runBulkOperation(tasks, ids, "empty-trash-item-failed");
    await flushMicrotasks();

    // Exactly 5 in flight: not 0 (tasks never invoked) and not 12 (unbounded
    // fan-out).
    expect(inFlight).toBe(5);
    expect(maxInFlight).toBe(5);

    while (release.length > 0) {
      release.shift()?.();
      await flushMicrotasks();
    }

    const { succeededIds, failedCount } = await batch;
    expect(maxInFlight).toBe(5);
    expect(succeededIds.size).toBe(12);
    expect(failedCount).toBe(0);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
