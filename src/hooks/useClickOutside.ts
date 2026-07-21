import { useEffect, useRef, RefObject } from "react";

/**
 * Closes a dropdown/menu when a mousedown occurs outside the referenced
 * element. Consolidates a pattern that was independently reimplemented
 * (identically) in LanguageDropdown.tsx, ThemeDropdown.tsx, and
 * TrashScreen.tsx's "more menu".
 *
 * Only attaches the `mousedown` listener while `active` is true (matching
 * all three original implementations), so there's zero listener overhead
 * while the menu is closed.
 *
 * `onOutside` is read via a ref rather than being a direct effect
 * dependency, so passing a fresh inline arrow function on every render
 * (the common call shape: `useClickOutside(ref, isOpen, () => setIsOpen(false))`)
 * does not tear down and re-add the listener on every render — the effect
 * itself only re-runs when `active` (or the ref object identity, which is
 * normally stable) actually changes.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
): void {
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;

  useEffect(() => {
    if (!active) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onOutsideRef.current();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [active, ref]);
}
