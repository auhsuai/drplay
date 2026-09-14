import { useEffect, useState } from "react";
import { ArrowLeft, HardDrive, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { ROOT_FOLDER_KEY } from "../../utils/storageKeys";
import { captureError } from "../../utils/errorLog";
import { useFolderPicker } from "./useFolderPicker";
import { FolderGrid } from "./FolderGrid";
import { FolderBreadcrumb } from "./FolderBreadcrumb";
import { FolderSearchInput } from "./FolderSearchInput";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

interface FolderSelectionScreenProps {
  token: string;
  onSelectFolder: (folderId: string) => void;
  onCancel?: (() => void) | undefined; // Optional cancel for when called from Settings
  initialFolderId?: string;
  initialFolderName?: string | undefined;
  initialFolderHistory?: { id: string; name: string }[] | undefined;
  title?: string;
  subtitle?: string;
  appRootFolder?: string | null;
  allowEscapeRoot?: boolean;
}

// Body attribute flag marking that a move picker is mounted. The picker's
// navigation state lives deep inside per-row MoreMenu state, so ancestors
// (MainContent) cannot see it through props — they read this flag to stand
// down their own Backspace handler and avoid a double navigation. Single
// source of truth: set on mount, removed on unmount below. (An attribute
// instead of dataset: set/remove/hasAttribute keeps the linter's
// no-dynamic-delete rule happy.)
export const MOVE_PICKER_OPEN_ATTR = "data-move-picker-open";

export function FolderSelectionScreen({
  token,
  onSelectFolder,
  onCancel,
  initialFolderId = ROOT_FOLDER_ID,
  initialFolderName,
  initialFolderHistory = [],
  title,
  subtitle,
  appRootFolder,
  allowEscapeRoot = false,
}: FolderSelectionScreenProps) {
  const { t } = useTranslation();

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Empty states"): the folder
  // data comes from useFolderPicker (not settable from outside), so a local
  // flag overrides the props handed to FolderGrid instead. onDebugEvent
  // no-ops in production builds; the listener never runs there.
  const [debugForceEmpty, setDebugForceEmpty] = useState(false);

  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.FOLDERS_EMPTY, () => {
      setDebugForceEmpty(true);
    });
  }, []);

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Loading / MainContent"):
  // forces the folder grid skeleton through the same prop-override pattern
  // as the FOLDERS_EMPTY trigger above. onDebugEvent no-ops in production
  // builds; the listener never runs there.
  const [debugForceLoading, setDebugForceLoading] = useState(false);

  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.SKELETON, (detail) => {
      if (detail.target === "folders") {
        setDebugForceLoading(true);
      }
    });
  }, []);

  // Resolve appRootFolder from props or localStorage.
  // localStorage access can throw SecurityError (storage blocked by policy —
  // see MDN Window.localStorage), so the read is guarded and falls back to
  // null (same as a missing key).
  let storedAppRoot: string | null = null;
  try {
    storedAppRoot = localStorage.getItem(ROOT_FOLDER_KEY);
  } catch (err) {
    void captureError({
      level: "warn",
      source: "FolderSelectionScreen",
      message: `root-folder-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
  }
  const resolvedAppRoot = appRootFolder || storedAppRoot;

  const {
    isLoading,
    searchQuery,
    setSearchQuery,
    filteredFolders,
    apiSearchResults,
    isSearchingApi,
    currentFolderId,
    currentFolderName,
    folderHistory,
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
    searchInputRef,
  } = useFolderPicker({
    token,
    initialFolderId,
    initialFolderName,
    initialFolderHistory,
    allowEscapeRoot,
    resolvedAppRoot,
  });

  // Announce this picker's presence to ancestor views (see flag contract
  // above). Every instance (bulk-move, per-row move, setup gates) sets it —
  // only one picker is ever mounted at a time, so a plain set/delete pair
  // cannot leak a stale flag.
  useEffect(() => {
    document.body.setAttribute(MOVE_PICKER_OPEN_ATTR, "true");
    return () => {
      document.body.removeAttribute(MOVE_PICKER_OPEN_ATTR);
    };
  }, []);

  // Backspace steps back one UI level inside the picker: pop the picker's own
  // history (or walk to the Drive parent, same as the toolbar Back button),
  // and close the picker when already at its root. Shared guards: editable
  // focus (Backspace deletes text there), modifier chords, in-flight load.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Backspace") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      const focusedEditable =
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable);
      if (focusedEditable) return;
      if (isLoading) return;
      const atPickerRoot =
        folderHistory.length === 0 &&
        (currentFolderId === ROOT_FOLDER_ID ||
          (!allowEscapeRoot && currentFolderId === resolvedAppRoot));
      if (atPickerRoot) {
        onCancel?.();
        return;
      }
      void handleBack();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    folderHistory,
    handleBack,
    onCancel,
    isLoading,
    currentFolderId,
    resolvedAppRoot,
    allowEscapeRoot,
  ]);

  // Escape closes the picker (first-run setup gates have no onCancel: the
  // press is swallowed anyway — nothing behind the overlay may react).
  // Window CAPTURE: the picker is the innermost overlay, so it must swallow
  // the press before the drawer (window bubble) and menu (document bubble)
  // layers. Staged like the queue search (QSI-1): a press inside a non-empty
  // search field only clears it and keeps the picker open; every other
  // press cancels. This is the single source of truth for Esc inside the
  // picker — the duplicate branch in useFolderPicker was removed.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (
        document.activeElement === searchInputRef.current &&
        searchQuery.trim() !== ""
      ) {
        searchInputRef.current?.blur();
        setSearchQuery("");
        return;
      }
      onCancel?.();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onCancel, searchQuery, setSearchQuery, searchInputRef]);

  // APG dialog-modal focus return: restore the invoker (row ⋯ trigger or the
  // toolbar bulk-move button) when the picker unmounts. The per-row path
  // opens from a menu item whose unmount already moved focus to body, so this
  // restores nothing there — MoreMenu's onCancel re-focuses its trigger;
  // the bulk path keeps the toolbar button mounted, so it is restored here.
  useEffect(() => {
    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      if (
        invoker &&
        invoker !== document.body &&
        invoker !== document.documentElement &&
        invoker.isConnected
      ) {
        invoker.focus();
      }
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget && onCancel) onCancel();
      }}
    >
      <div className="bg-white dark:bg-[#121212] w-full max-w-3xl h-[75vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
              <HardDrive className="text-brand-text w-6 h-6" />
              {title || t("folder_selection.select_root")}
            </h1>
            <p className="text-xs text-gray-500 mt-1">
              {subtitle || t("folder_selection.select_music_folder")}
            </p>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                ></path>
              </svg>
            </button>
          )}
        </div>

        {/* Toolbar / Breadcrumb / Search */}
        <div className="px-6 py-3 flex items-center gap-2 shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50">
          <button
            onClick={() => {
              void handleBack();
            }}
            disabled={
              folderHistory.length === 0 &&
              (currentFolderId === ROOT_FOLDER_ID ||
                (!allowEscapeRoot && currentFolderId === resolvedAppRoot))
            }
            className="p-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4 text-gray-700 dark:text-gray-300" />
          </button>

          <FolderBreadcrumb
            folderHistory={folderHistory}
            currentFolderName={currentFolderName}
            onBreadcrumbClick={handleBreadcrumbClick}
          />

          <FolderSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            inputRef={searchInputRef}
          />
        </div>

        {/* Folder List */}
        <FolderGrid
          isLoading={
            debugForceLoading ? true : debugForceEmpty ? false : isLoading
          }
          isSearchingApi={isSearchingApi}
          searchQuery={searchQuery}
          filteredFolders={debugForceEmpty ? [] : filteredFolders}
          apiSearchResults={apiSearchResults}
          onOpenFolder={handleOpenFolder}
        />

        {/* Footer Actions */}
        <div className="px-6 py-4 flex items-center justify-end gap-3 shrink-0">
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              {t("folder_selection.cancel")}
            </button>
          )}
          <button
            onClick={() => {
              onSelectFolder(currentFolderId);
            }}
            className="flex items-center gap-2 bg-brand-primary hover:bg-brand-hover text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all transform active:scale-[0.98] shadow-sm"
          >
            <Check className="w-4 h-4" />
            {t("folder_selection.choose_folder")}
          </button>
        </div>
      </div>
    </div>
  );
}
