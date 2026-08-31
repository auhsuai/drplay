import React, { useState, useEffect, useCallback } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useHardwareBack } from "../../hooks/useHardwareBack";

export interface SortOption {
  id: string;
  label: string;
  // Why: My Drive opens "Ngày" in newest-first (desc) mode because drive
  // items carry a real modifiedTime; the Recent view opens it in
  // newest-first (asc) mode because the recent list is already
  // createdAt-desc. The flag lets each caller pick the direction its
  // "date" option lands on when clicked.
  defaultDesc?: boolean;
}

interface SortDropdownProps {
  sortOption: string;
  onSortChange?: ((option: string) => void) | undefined;
  options: SortOption[];
  fallbackLabel?: string;
  isInitialMount?: React.RefObject<boolean>;
}

export function SortDropdown({
  sortOption,
  onSortChange,
  options,
  fallbackLabel = "Sort",
}: SortDropdownProps) {
  const { t } = useTranslation();
  const [showSortMenu, setShowSortMenu] = useState(false);
  // The arrow animation must be skipped on the very first committed frame
  // (the arrows would "fill" from nothing), then animate on every later
  // toggle. The flag lives in state (reading a ref during render is
  // forbidden) and flips asynchronously after mount (setTimeout 0), so the
  // skip only ever applies to the first frame. Callers still pass the shared
  // isInitialMount ref (interface kept for API compatibility) — in every real
  // lifecycle it is true at this component's mount.
  const [isFirstFrame, setIsFirstFrame] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsFirstFrame(false);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  const baseSortOption = sortOption.replace(" desc", "");
  // Why: callers always pass a pre-translated fallbackLabel (e.g. "Sort");
  // the default prop is a plain 'Sort' safety fallback.
  const label = fallbackLabel;
  const currentSortLabel =
    options.find((opt) => opt.id === baseSortOption)?.label || label;

  // Hardware back (mobile): closes the sort menu when open — without this,
  // the press falls through to the folder-up chain.
  useHardwareBack(
    useCallback(() => {
      setShowSortMenu(false);
      return true;
    }, []),
    showSortMenu,
  );

  // Desktop keyboard: Escape closes the menu while open (UploadButton
  // pattern); the listener exists only while the menu is open and other
  // keys pass through untouched.
  useEffect(() => {
    if (!showSortMenu) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSortMenu(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showSortMenu]);

  return (
    <div className="relative">
      {/* APG forbids nested interactive controls: the label region (menu
          trigger) and the arrow (asc/desc flip) are two SIBLING buttons.
          flex-row-reverse keeps the original left-arrow/right-label look
          while DOM order stays trigger-first for Tab. */}
      <div className="flex flex-row-reverse items-center gap-1.5 [&:active:not(:has(.arrow-btn:active))]:scale-95 select-none">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={showSortMenu}
          aria-haspopup="listbox"
          aria-controls="sort-menu"
          aria-label={t("sort.menu")}
          onClick={() => {
            setShowSortMenu(!showSortMenu);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setShowSortMenu(!showSortMenu);
            }
          }}
          className="flex items-center px-3 py-1.5 text-sm font-medium bg-gray-500 hover:bg-gray-600 text-white dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-100 rounded-lg transition-all shadow-sm cursor-pointer select-none"
        >
          {/* Why grid: label + invisible option-label spans stack in the same
              cell to keep the chip width stable across sort choices. The
              container must be visible on mobile too (no `hidden sm:`) — the
              chip is the only affordance showing the active sort there. */}
          <div className="grid text-center pr-1">
            <span className="col-start-1 row-start-1 visible place-self-center">
              {currentSortLabel}
            </span>
            {options.map((opt) => (
              <span
                key={opt.id}
                className="col-start-1 row-start-1 invisible pointer-events-none select-none"
                aria-hidden="true"
              >
                {opt.label}
              </span>
            ))}
          </div>
        </div>
        <div
          role="button"
          tabIndex={0}
          className="arrow-btn p-1 rounded-md bg-white dark:bg-[#1a1b1e] shadow-sm hover:bg-gray-200 dark:hover:bg-[#2e2f34] transition-transform active:scale-75 flex items-center justify-center cursor-pointer select-none"
          onClick={(e) => {
            e.stopPropagation();
            if (sortOption.endsWith(" desc")) {
              onSortChange?.(sortOption.replace(" desc", ""));
            } else {
              onSortChange?.(sortOption + " desc");
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (sortOption.endsWith(" desc")) {
                onSortChange?.(sortOption.replace(" desc", ""));
              } else {
                onSortChange?.(sortOption + " desc");
              }
            }
          }}
          title={t("sort.toggle_order")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4 relative"
          >
            {/* Gray UP Arrow (Inverse animated) — the inactive arrow must stay
                visible per Material icon hierarchy (active = primary, inactive
                = ~50% gray); pure white vanished on the white button. */}
            <g
              className={`stroke-gray-400 ${isFirstFrame ? (!sortOption.endsWith(" desc") ? "opacity-0" : "") : !sortOption.endsWith(" desc") ? "anim-drain-up" : "anim-fill-up"}`}
            >
              <path d="m3 8 4-4 4 4" />
              <path d="M7 4v16" />
            </g>

            {/* Blue UP Arrow */}
            <g
              className={`stroke-brand-primary ${isFirstFrame ? (!sortOption.endsWith(" desc") ? "" : "opacity-0") : !sortOption.endsWith(" desc") ? "anim-fill-up" : "anim-drain-up"}`}
            >
              <path d="m3 8 4-4 4 4" />
              <path d="M7 4v16" />
            </g>

            {/* Gray DOWN Arrow (Inverse animated) — see the UP arrow note. */}
            <g
              className={`stroke-gray-400 ${isFirstFrame ? (sortOption.endsWith(" desc") ? "opacity-0" : "") : sortOption.endsWith(" desc") ? "anim-drain-down" : "anim-fill-down"}`}
            >
              <path d="m21 16-4 4-4-4" />
              <path d="M17 20V4" />
            </g>

            {/* Blue DOWN Arrow */}
            <g
              className={`stroke-brand-primary ${isFirstFrame ? (sortOption.endsWith(" desc") ? "" : "opacity-0") : sortOption.endsWith(" desc") ? "anim-fill-down" : "anim-drain-down"}`}
            >
              <path d="m21 16-4 4-4-4" />
              <path d="M17 20V4" />
            </g>
          </svg>
        </div>
      </div>

      {showSortMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            role="presentation"
            onClick={() => {
              setShowSortMenu(false);
            }}
          ></div>
          <div
            id="sort-menu"
            role="listbox"
            aria-label={t("sort.menu")}
            data-testid="sort-menu"
            className="absolute right-0 mt-1 min-w-full w-max bg-white dark:bg-[#1a1b1e] rounded-xl shadow-lg p-1.5 flex flex-col gap-0.5 z-50 animate-in fade-in slide-in-from-top-2 duration-200"
          >
            {options.map((opt) => (
              <button
                key={opt.id}
                role="option"
                aria-selected={baseSortOption === opt.id}
                onClick={() => {
                  const newOpt = opt.defaultDesc ? `${opt.id} desc` : opt.id;
                  onSortChange?.(newOpt);
                  setShowSortMenu(false);
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 text-sm transition-colors rounded-md hover:bg-gray-50 dark:hover:bg-[#25262a] hover:text-brand-primary dark:hover:text-brand-primary ${baseSortOption === opt.id ? "text-brand-primary font-medium" : "text-gray-700 dark:text-gray-300"}`}
              >
                {opt.label}
                {baseSortOption === opt.id && <Check className="w-4 h-4" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
