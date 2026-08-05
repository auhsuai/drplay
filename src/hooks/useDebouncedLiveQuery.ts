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

  // Keep the latest querier in the ref without writing during render
  // (react-hooks/refs). Effects run in declaration order, so the ref is
  // always fresh by the time the debounced query effect below reads it.
  useEffect(() => {
    querierRef.current = querier;
  }, [querier]);

  useEffect(() => {
    let cancelled = false;
    const handler = async () => {
      try {
        const data = await querierRef.current();
        if (!cancelled) setResult(data);
      } catch {
        // A failed query must not clear the last good data — keep showing it
        // and surface the failure through observability only.
        void captureError({
          level: "warn",
          source: "useDebouncedLiveQuery",
          message: "debounced-query-failed",
        });
      }
    };
    const timer = setTimeout(() => {
      void handler();
    }, delayMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // deps is an explicit generic-hook dependency list by design: spread deps
    // cannot be statically verified, and enumerating `deps` itself would
    // re-run the query on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, delayMs]);

  return result;
}
