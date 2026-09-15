import { captureError } from "../../utils/errorLog";
import { createSemaphore } from "../../utils/asyncLimit";

export const TRASH_MODULE = "TrashScreen";

// Trash lists paginate without a cap (1000 items per page), so fanning out one
// request per item would burst the Drive rate limiter. 5 in-flight requests
// keeps large selections from taking minutes while staying polite to the rate
// limiter (parity with useDriveBulkOps BULK_CONCURRENCY).
const BULK_CONCURRENCY = 5;

// The three bulk handlers (empty trash / bulk restore / bulk delete) share
// the same shape: run an async op per id, keep the succeeded set, count
// failures, log each failure with a per-op message prefix.
export async function runBulkOperation(
  tasks: Array<() => Promise<unknown>>,
  ids: string[],
  messagePrefix: string,
): Promise<{ succeededIds: Set<string>; failedCount: number }> {
  const semaphore = createSemaphore(BULK_CONCURRENCY);
  const results = await Promise.allSettled(
    tasks.map((task) => semaphore.run(task)),
  );
  const succeededIds = new Set<string>();
  let failedCount = 0;
  results.forEach((result, index) => {
    const id = ids[index];
    if (id === undefined) return;
    if (result.status === "fulfilled") {
      succeededIds.add(id);
    } else {
      failedCount += 1;
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `${messagePrefix} for fileId=${id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      });
    }
  });
  return { succeededIds, failedCount };
}

// After a partial bulk failure, drop the succeeded ids from the selection so
// the user only retries what actually failed.
export function removeIdsFromSelection(
  selectedIds: Set<string>,
  succeededIds: Set<string>,
): Set<string> {
  const next = new Set(selectedIds);
  succeededIds.forEach((id) => next.delete(id));
  return next;
}

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
