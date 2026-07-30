import { useState, useRef, useEffect, DependencyList } from 'react';

export function useDebouncedLiveQuery<T>(
  querier: () => Promise<T>,
  deps: DependencyList,
  delayMs = 100
): T | undefined {
  const [result, setResult] = useState<T>();
  const querierRef = useRef(querier);
  querierRef.current = querier;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const data = await querierRef.current();
      if (!cancelled) setResult(data);
    }, delayMs);
    
    return () => { 
      cancelled = true; 
      clearTimeout(timer); 
    };
  }, deps);

  return result;
}
