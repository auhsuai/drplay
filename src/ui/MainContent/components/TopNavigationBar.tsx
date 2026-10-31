import React from "react";
import { ArrowLeft, X, Search, FolderPlus, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MY_DRIVE_TAB, VIRTUAL_ROOT_NAME } from "../../../utils/driveConstants";
import { useHorizontalScroll } from "../../../hooks/useHorizontalScroll";
import type { SearchMode } from "../../../hooks/useDriveSearch";

interface TopNavigationBarProps {
  isSelectionMode: boolean;
  selectedCount: number;
  onClearSelection: () => void;
  onBack: () => void;
  hasHistory: boolean;
  folderHistory: { id: string; name: string }[];
  currentFolderName: string;
  onBreadcrumbClick: (id: string, name: string, index: number) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  // Search mode toggle (Phase B): absent/undefined keeps the plain
  // decorative Search icon (other call sites and tests unaffected).
  searchMode?: SearchMode | undefined;
  onToggleSearchMode?: () => void;
  // Sorting is owned by the FileListHeader column row now; these two stay in
  // the interface because MainContent/TabContentRouter still thread the same
  // sortOption + onSortChange chain (the header consumes them directly).
  sortOption: string;
  onSortChange?: ((option: string) => void) | undefined;
  token: string | null;
  onNewFolderClick: () => void;
  // false hides the New Folder action (virtual root: no real parent folder).
  showNewFolderButton?: boolean;
  // Retained for call-site compatibility (previously drove the removed
  // SortDropdown's first-frame arrow animation; no consumer inside this
  // component anymore — do not remove without updating MainContent).
  isInitialMount: React.RefObject<boolean>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

// Recursive search mode icon (Phase B): inline Tabler "folders" SVG, pinned
// verbatim by the Phase A spec (B5) — keep path/viewBox/stroke attrs exactly
// as pinned; size is driven by the className (w-4 h-4), not the width/height
// attributes (they stay 24 per the Tabler original).
function SearchFoldersIcon({ className }: { className: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M9 3h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2" />
      <path d="M17 16v2a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2h2" />
    </svg>
  );
}

export function TopNavigationBar({
  isSelectionMode,
  selectedCount,
  onClearSelection,
  onBack,
  hasHistory,
  folderHistory,
  currentFolderName,
  onBreadcrumbClick,
  searchQuery,
  onSearchChange,
  searchMode,
  onToggleSearchMode,
  token,
  onNewFolderClick,
  showNewFolderButton = true,
  searchInputRef,
}: TopNavigationBarProps) {
  const { t } = useTranslation();

  // Wheel + drag horizontal scroll — shared with the picker breadcrumb
  // (useHorizontalScroll). Disabled while the selection bar replaces the
  // breadcrumb (no container to attach to).
  const breadcrumbRef = useHorizontalScroll(!isSelectionMode);

  // Why: the breadcrumb stores the raw root-folder label (MY_DRIVE_TAB) from
  // the Drive state; translate it for display so the breadcrumb matches the
  // sidebar's localized "My Drive" entry. Non-root folder names are untouched.
  const displayFolderName = (name: string): string => {
    if (name === MY_DRIVE_TAB) return t("drive.my_drive");
    if (name === VIRTUAL_ROOT_NAME) return t("drive.root_folders");
    return name;
  };

  // Search mode toggle (Phase B + user feedback 2026-10-31): whenever the
  // mode props are wired the left gutter shows the CURRENT mode icon —
  // Globe = global, folders = recursive — as an accessible toggle button in
  // EVERY query state (empty included, so the user sees and can flip the
  // mode before typing). The decorative magnifier survives only for callers
  // that do not wire the mode props (backward compat). The button mirrors
  // the toolbar's existing icon-button pattern (rounded hover classes) and
  // stays absolutely positioned over the input's left gutter so the text
  // never shifts; the query is untouched on toggle.
  const isModeToggle =
    (searchMode === "global" || searchMode === "recursive") &&
    onToggleSearchMode !== undefined;
  const modeButtonClasses =
    "z-10 absolute left-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors";

  return (
    // Visual-only -2px nudge (relative + -top-0.5, not a negative margin):
    // the toolbar paints 2px higher while normal flow is untouched, so the
    // FileListHeader row below keeps its exact position and mt-2 spacing.
    <div className="relative -top-0.5 flex items-center justify-between gap-4">
      {isSelectionMode ? (
        <div className="flex items-center gap-2 text-sm font-medium animate-in fade-in slide-in-from-left-4 duration-300 flex-1 min-w-0">
          <button
            onClick={onClearSelection}
            aria-label={t("common.exit_selection")}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mr-2 shrink-0"
          >
            <X className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          </button>
          <span className="text-gray-900 dark:text-white px-2 py-1 font-semibold text-lg truncate">
            {t("drive.items_selected", { count: selectedCount })}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm font-medium flex-1 min-w-0">
          <button
            onClick={onBack}
            disabled={!hasHistory}
            aria-label={t("common.back")}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors shrink-0"
          >
            <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          </button>

          <div
            ref={breadcrumbRef}
            className="flex items-center overflow-x-auto whitespace-nowrap hide-scrollbar flex-1 min-w-0"
          >
            {folderHistory.map((folder, index) => (
              <div key={folder.id} className="flex items-center shrink-0">
                <span className="text-gray-400 mx-1">/</span>
                <button
                  onClick={() => {
                    onBreadcrumbClick(folder.id, folder.name, index);
                  }}
                  className="text-gray-500 dark:text-gray-400 hover:text-brand-text transition-colors truncate max-w-[150px]"
                  title={displayFolderName(folder.name)}
                >
                  {displayFolderName(folder.name)}
                </button>
              </div>
            ))}
            <div className="flex items-center shrink-0">
              {folderHistory.length > 0 && (
                <span className="text-gray-400 mx-1">/</span>
              )}
              <span
                className="text-gray-900 dark:text-white px-2 py-1 font-semibold truncate max-w-[200px]"
                title={displayFolderName(currentFolderName)}
              >
                {displayFolderName(currentFolderName)}
              </span>
            </div>
          </div>
        </div>
      )}

      {!isSelectionMode && (
        <div className="flex items-center gap-3 shrink-0">
          {/* Search Input */}
          <div className="relative">
            {isModeToggle ? (
              <button
                type="button"
                onClick={onToggleSearchMode}
                aria-label={t(
                  searchMode === "global"
                    ? "search.switch_to_recursive"
                    : "search.switch_to_global",
                )}
                title={t(
                  searchMode === "global"
                    ? "search.switch_to_recursive"
                    : "search.switch_to_global",
                )}
                className={modeButtonClasses}
              >
                {searchMode === "global" ? (
                  <Globe className="w-4 h-4 text-gray-400" aria-hidden="true" />
                ) : (
                  <SearchFoldersIcon className="w-4 h-4 text-gray-400" />
                )}
              </button>
            ) : (
              // z-10 pins the icon above the input's own paint. Without it the
              // focused input (focus ring box-shadow render on WebView2 154)
              // could repaint over the positioned-but-unstacked icon — the
              // "magnifier vanishes on click/Ctrl+F" regression. z-auto loses
              // that race; an explicit stacking wins it unconditionally.
              <Search className="z-10 w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            )}
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t("search_placeholder")}
              aria-label={t("search_placeholder")}
              value={searchQuery}
              onChange={(e) => {
                onSearchChange(e.target.value);
              }}
              className="w-40 sm:w-56 pl-9 pr-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-[#1a1b1e] text-gray-900 dark:text-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-brand-primary/50 border border-transparent focus:border-transparent transition-all placeholder:text-gray-400"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  onSearchChange("");
                }}
                aria-label={t("common.clear_search")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sorting lives in the FileListHeader column row now — the old
              SortDropdown was removed app-wide (My Drive and the Recent full
              views both sort through their FileListHeader instances). */}
          {token && showNewFolderButton && (
            <button
              onClick={onNewFolderClick}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-brand-primary hover:bg-brand-hover rounded-lg transition-colors shadow-sm active:scale-95"
            >
              <FolderPlus className="w-4 h-4" />
              <span className="hidden sm:inline">{t("drive.new_folder")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
