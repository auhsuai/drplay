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
    // order: editable focus first (Backspace deletes text there), then
    // modifier chords, then any overlay stacked above this view. The move
    // picker owns the press via its body attribute flag (its state lives in
    // per-row MoreMenu and is invisible here); context menus render only as
    // a portalled [role="menu"] while open. No stopImmediatePropagation:
    // each layer stands down on its own guard instead of depending on
    // listener registration order.
    if (e.key === "Backspace") {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(document.activeElement)) return;
      if (showNewFolderModal || showBulkMoveScreen || showBulkDeleteConfirm)
        return;
      if (isNowPlayingOpen) return;
      if (
        document.body.hasAttribute(MOVE_PICKER_OPEN_ATTR) ||
        document.querySelector('[role="menu"]') !== null
      )
        return;
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

  // Enable selection mode from events
  const handleEnableSelection = (e: Event) => {
    // detail is typed | null because a CustomEvent constructed without the
    // detail option defaults to null at runtime.
    const customEvent = e as CustomEvent<{ id?: string } | null>;
    if (customEvent.detail?.id) {
      setIsSelectionMode(true);
      setSelectedIds(new Set([customEvent.detail.id]));
    }
  };
  useEventListener("enable-selection-mode", handleEnableSelection, [
    setIsSelectionMode,
    setSelectedIds,
  ]);
}
