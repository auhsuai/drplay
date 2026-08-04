import { useEffect, useRef } from "react";

export function useEventListener<K extends keyof WindowEventMap>(
  eventName: K,
  handler: (event: WindowEventMap[K]) => void,
  deps?: ReadonlyArray<unknown>,
): void;
export function useEventListener(
  eventName: string,
  handler: (event: Event) => void,
  deps?: ReadonlyArray<unknown>,
): void;
export function useEventListener(
  eventName: string,
  handler: (event: Event) => void,
  deps: ReadonlyArray<unknown> = [],
): void {
  const savedHandler = useRef(handler);
  useEffect(() => {
    savedHandler.current = handler;
  }, [handler]);
  useEffect(() => {
    const listener = (event: Event) => savedHandler.current(event);
    window.addEventListener(eventName, listener);
    return () => window.removeEventListener(eventName, listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventName, ...deps]);
}
