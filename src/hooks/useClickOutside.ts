import { useEffect, useRef } from "react";
import type { RefObject } from "react";

type ClickOutsideRef = RefObject<HTMLElement | null>;

// Proper type-predicate wrapper: Array.isArray alone narrows the refs union
// to any[] (its lib signature is `arg is any[]`), which trips the
// no-unsafe-* rules.
function isRefArray(
  value: ClickOutsideRef | ReadonlyArray<ClickOutsideRef>,
): value is ReadonlyArray<ClickOutsideRef> {
  return Array.isArray(value);
}

// React 19 custom-hook pattern (savedCallback): keep the latest handler and
// refs in refs so the document-level mousedown listener binds once per
// `active` transition instead of re-binding on every render when callers
// pass inline ref arrays (useMoreMenuEvents).
export function useClickOutside(
  refs: ClickOutsideRef | ReadonlyArray<ClickOutsideRef>,
  handler: () => void,
  active = true,
): void {
  const refsRef = useRef(refs);
  const handlerRef = useRef(handler);

  useEffect(() => {
    refsRef.current = refs;
    handlerRef.current = handler;
  }, [refs, handler]);

  useEffect(() => {
    if (!active) return;
    const refList = isRefArray(refsRef.current)
      ? refsRef.current
      : [refsRef.current];
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      // Detached refs (current === null) never block: a click is "outside"
      // when it is not contained in ANY attached ref.
      const isOutside = refList.every((ref) => {
        const el = ref.current;
        return el === null || !el.contains(target);
      });
      if (isOutside) handlerRef.current();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [active]);
}
