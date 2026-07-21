import { useEffect, useRef, RefObject } from "react";

/**
 * Closes a dropdown/menu when a mousedown occurs outside the referenced
 * element(s). Consolidates a pattern that was independently reimplemented
 * (identically) in LanguageDropdown.tsx, ThemeDropdown.tsx, and
 * TrashScreen.tsx's "more menu".
 *
 * Only attaches the `mousedown` listener while `active` is true (matching
 * all original implementations), so there's zero listener overhead while
 * the menu is closed.
 *
 * `onOutside` is read via a ref rather than being a direct effect
 * dependency, so passing a fresh inline arrow function on every render
 * (the common call shape: `useClickOutside(ref, isOpen, () => setIsOpen(false))`)
 * does not tear down and re-add the listener on every render — the effect
 * itself only re-runs when `active` (or the ref array identity) actually
 * changes.
 *
 * Accepts either a single ref or an array of refs — a click only counts as
 * "outside" when it lands outside ALL of them. This is needed for
 * MoreMenu.tsx, whose trigger button and its (separately-positioned)
 * dropdown panel are two distinct elements: a click on the panel must not
 * close the menu, even though the panel isn't inside the button's ref.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  active: boolean,
  onOutside: () => void,
): void {
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;
  const refs = Array.isArray(ref) ? ref : [ref];

  useEffect(() => {
    if (!active) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideAny = refs.some((r) => r.current && r.current.contains(target));
      if (!isInsideAny) {
        onOutsideRef.current();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refs` is a new
    // array literal every render when called with an array; the ref OBJECTS
    // inside it are what's stable (assigned once by useRef in the caller).
    // Depending on `refs` itself would re-add the listener every render.
  }, [active, ...refs]);
}
