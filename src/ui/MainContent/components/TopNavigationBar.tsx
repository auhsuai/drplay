import React, { useEffect, useRef } from "react";
import { ArrowLeft, X, Search, FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SortDropdown } from "../../components/SortDropdown";
import { MY_DRIVE_TAB } from "../../../utils/driveConstants";
import { captureError } from "../../../utils/errorLog";

const TOP_NAVIGATION_BAR_MODULE = "TopNavigationBar";
const DRAG_THRESHOLD_PX = 5;

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
  sortOption: string;
  onSortChange?: ((option: string) => void) | undefined;
  token: string | null;
  onNewFolderClick: () => void;
  isInitialMount: React.RefObject<boolean>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
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
  sortOption,
  onSortChange,
  token,
  onNewFolderClick,
  isInitialMount,
  searchInputRef,
}: TopNavigationBarProps) {
  const { t } = useTranslation();

  const breadcrumbRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{
    startX: number;
    startScrollLeft: number;
  } | null>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (isSelectionMode) return;
    const el = breadcrumbRef.current;
    if (!el) return;

    // Why: overflow-x-auto only scrolls from wheel deltaX (trackpad); a mouse
    // wheel emits deltaY, so the breadcrumb never scrolls horizontally with a
    // mouse. React 19 attaches wheel passively at the root where
    // preventDefault would be ignored, hence a native non-passive listener.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      el.scrollLeft += e.deltaY + e.deltaX;
    };

    // Why: capture only starts once the pointer actually moves beyond
    // DRAG_THRESHOLD_PX. Capturing on pointerdown would retarget pointerup
    // (and the subsequent click) to this container, so a plain click on a
    // breadcrumb button would never fire onBreadcrumbClick.
    const onPointerDown = (e: PointerEvent) => {
      dragStartRef.current = {
        startX: e.clientX,
        startScrollLeft: el.scrollLeft,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      if (!isDraggingRef.current) {
        if (Math.abs(e.clientX - drag.startX) <= DRAG_THRESHOLD_PX) return;
        isDraggingRef.current = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch (err) {
          void captureError({
            level: "warn",
            source: TOP_NAVIGATION_BAR_MODULE,
            message: `set-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      el.scrollLeft = drag.startScrollLeft - (e.clientX - drag.startX);
    };

    const endDrag = (e: PointerEvent) => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        try {
          if (el.hasPointerCapture(e.pointerId)) {
            el.releasePointerCapture(e.pointerId);
          }
        } catch (err) {
          void captureError({
            level: "warn",
            source: TOP_NAVIGATION_BAR_MODULE,
            message: `release-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      dragStartRef.current = null;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endDrag);
      el.removeEventListener("pointercancel", endDrag);
    };
  }, [isSelectionMode]);

  // Why: the breadcrumb stores the raw root-folder label (MY_DRIVE_TAB) from
  // the Drive state; translate it for display so the breadcrumb matches the
  // sidebar's localized "My Drive" entry. Non-root folder names are untouched.
  const displayFolderName = (name: string): string =>
    name === MY_DRIVE_TAB ? t("drive.my_drive", "My Drive") : name;

  const sortOptions = [
    { id: "name", label: t("sort.name", "A-Z") },
    { id: "modifiedTime", label: t("sort.date", "Ngày"), defaultDesc: true },
    { id: "size", label: t("sort.size", "Kích thước") },
  ];

  return (
    <div className="flex items-center justify-between gap-4">
      {isSelectionMode ? (
        <div className="flex items-center gap-2 text-sm font-medium animate-in fade-in slide-in-from-left-4 duration-300 flex-1 min-w-0">
          <button
            onClick={onClearSelection}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mr-2 shrink-0"
          >
            <X className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          </button>
          <span className="text-gray-900 dark:text-white px-2 py-1 font-semibold text-lg truncate">
            {t("drive.items_selected", "{{count}} mục đã chọn", {
              count: selectedCount,
            })}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm font-medium flex-1 min-w-0">
          <button
            onClick={onBack}
            disabled={!hasHistory}
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
                  className="text-gray-500 dark:text-gray-400 hover:text-[#4285F4] transition-colors truncate max-w-[150px]"
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
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t("search_placeholder", "Tìm kiếm...")}
              value={searchQuery}
              onChange={(e) => {
                onSearchChange(e.target.value);
              }}
              className="w-40 sm:w-56 pl-9 pr-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-[#1a1b1e] text-gray-900 dark:text-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-[#4285F4]/50 border border-transparent focus:border-transparent transition-all placeholder:text-gray-400"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  onSearchChange("");
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort Dropdown */}
          {token && (
            <SortDropdown
              sortOption={sortOption}
              onSortChange={onSortChange}
              options={sortOptions}
              fallbackLabel={t("drive.sort", "Sort")}
              isInitialMount={isInitialMount}
            />
          )}

          {token && (
            <button
              onClick={onNewFolderClick}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-[#4285F4] hover:bg-[#3367d6] rounded-lg transition-colors shadow-sm active:scale-95"
            >
              <FolderPlus className="w-4 h-4" />
              <span className="hidden sm:inline">
                {t("drive.new_folder") || "New Folder"}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
