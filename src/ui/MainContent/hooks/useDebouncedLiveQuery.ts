import React from "react";

export function useDebouncedLiveQuery<T>(
  querier: () => Promise<T>,
  deps: React.DependencyList,
  delayMs = 100
): T | undefined {
  const [result, setResult] = React.useState<T>();
  const querierRef = React.useRef(querier);
  querierRef.current = querier;
  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const data = await querierRef.current();
      if (!cancelled) setResult(data);
    }, delayMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, deps);
  return result;
}
