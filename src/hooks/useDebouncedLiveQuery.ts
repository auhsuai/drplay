import type { DependencyList } from "react";
import { useState, useRef, useEffect } from "react";
import { captureError } from "../utils/errorLog";

export function useDebouncedLiveQuery<T>(
  querier: () => Promise<T>,
  deps: DependencyList,
  delayMs = 100,
): T | undefined {
  const [result, setResult] = useState<T>();
  const querierRef = useRef(querier);
  querierRef.current = querier;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await querierRef.current();
        if (!cancelled) setResult(data);
      } catch {
        // A failed query must not clear the last good data — keep showing it
        // and surface the failure through observability only.
        captureError({
          level: "warn",
          source: "useDebouncedLiveQuery",
          message: "debounced-query-failed",
        });
      }
    }, delayMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [...deps, delayMs]);

  return result;
}
