import { useEffect } from "react";

type BackHandler = () => boolean;
const handlers: BackHandler[] = [];

export function useHardwareBack(handler: BackHandler, isActive: boolean) {
  useEffect(() => {
    if (isActive) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx > -1) handlers.splice(idx, 1);
      };
    }
  }, [handler, isActive]);
}

export function handleGlobalBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    const handler = handlers[i];
    if (handler && handler()) {
      return true;
    }
  }
  return false;
}
