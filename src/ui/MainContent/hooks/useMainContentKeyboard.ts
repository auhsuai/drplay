import type { Dispatch, RefObject, SetStateAction } from "react";
import { MOVE_PICKER_OPEN_ATTR } from "../../FolderSelection/FolderSelectionScreen";
import { useEventListener } from "../../../hooks/useEventListener";

const isEditableTarget = (active: Element | null): boolean =>
  active instanceof HTMLElement &&
  (active.tagName === "INPUT" ||
    active.tagName === "TEXTAREA" ||
    active.isContentEditable);

export function useMainContentKeyboard({
  searchInputRef,
  setSearchQuery,
  isSelectionMode,
  setSelectedIds,
  setIsSelectionMode,
  showNewFolderModal,
  showBulkMoveScreen,
  showBulkDeleteConfirm,
  isNowPlayingOpen,
  hasHistory,
  onBack,
}: {
  searchInputRef: RefObject<HTMLInputElement | null>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  isSelectionMode: boolean;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setIsSelectionMode: Dispatch<SetStateAction<boolean>>;
  showNewFolderModal: boolean;
  showBulkMoveScreen: boolean;
  showBulkDeleteConfirm: boolean;
  isNowPlayingOpen: boolean;
  hasHistory: boolean;
  onBack: () => void;
}): void {
  // Keyboard shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    // Overlay guard: any dialog/screen stacked above this view owns the
    // keyboard (APG modal pattern — the background is inert). Escape must not
    // exit selection behind a modal, Ctrl+F must not pull focus to the
    // background search input, and Backspace must not navigate behind the
    // overlay. Predicate: modal flags, the NowPlaying overlay, the
    // folder-move picker (its state lives in per-row MoreMenu and is
    // invisible here, so it flags the body) and any portalled context menu.
    if (
      showNewFolderModal ||
      showBulkMoveScreen ||
      showBulkDeleteConfirm ||
      isNowPlayingOpen ||
      document.body.hasAttribute(MOVE_PICKER_OPEN_ATTR) ||
      document.querySelector('[role="menu"]') !== null
    )
      return;
    // key is normalized to lower case: with CapsLock or Shift held the
    // browser reports "F" for the F key (MDN KeyboardEvent.key).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
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
      return;
    }
    // Escape outside editable fields exits selection mode (staged: a press
    // inside the search input only clears the search above, the next press
    // exits selection). The editable guard keeps this handler from
    // double-firing alongside modal/page-edit inputs that own their own Esc.
    if (e.key === "Escape" && isSelectionMode) {
      const focusedEditable = isEditableTarget(document.activeElement);
      if (!focusedEditable) {
        setSelectedIds(new Set());
        setIsSelectionMode(false);
      }
    }
    // Backspace navigates back one folder (slice B). It never clears search,
    // exits selection, or closes modals — that is Esc's job (above). Guard
    // order: the overlay guard at the top of this handler already stood down
    // for stacked overlays; then editable focus (Backspace deletes text
    // there), then modifier chords. No stopImmediatePropagation: each layer
    // stands down on its own guard instead of depending on listener
    // registration order.
    if (e.key === "Backspace") {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(document.activeElement)) return;
      if (!hasHistory) return;
      onBack();
    }
  };
  useEventListener("keydown", handleKeyDown, [
    setSearchQuery,
    isSelectionMode,
    setSelectedIds,
    setIsSelectionMode,
    onBack,
    hasHistory,
    showNewFolderModal,
    showBulkMoveScreen,
    showBulkDeleteConfirm,
    isNowPlayingOpen,
  ]);
}
