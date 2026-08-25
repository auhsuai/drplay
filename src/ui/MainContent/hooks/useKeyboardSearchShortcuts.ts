import { useEventListener } from "../../../hooks/useEventListener";
import type { Dispatch, RefObject, SetStateAction } from "react";

// Keyboard shortcuts: Ctrl/Cmd+F toggles focus into/out of the search input
// (clearing the query on blur-toggle), Escape blurs it and clears the query.
export function useKeyboardSearchShortcuts(
  searchInputRef: RefObject<HTMLInputElement | null>,
  setSearchQuery: Dispatch<SetStateAction<string>>,
): void {
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
      e.preventDefault();
      if (document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur();
        setSearchQuery("");
      } else {
        searchInputRef.current?.focus();
      }
    }
    if (
      e.key === "Escape" &&
      document.activeElement === searchInputRef.current
    ) {
      searchInputRef.current?.blur();
      setSearchQuery("");
    }
  };
  useEventListener("keydown", handleKeyDown, [setSearchQuery]);
}
