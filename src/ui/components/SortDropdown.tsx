import React, { useState, useRef, useEffect } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

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
  isInitialMount?: React.MutableRefObject<boolean>;
}

export function SortDropdown({
  sortOption,
  onSortChange,
  options,
  fallbackLabel = "Sort",
  isInitialMount: isInitialMountProp,
}: SortDropdownProps) {
  const { t } = useTranslation();
  const [showSortMenu, setShowSortMenu] = useState(false);
  const internalInitialMount = useRef(true);
  // Why: the arrow animation must be skipped on first render (the arrows
  // would "fill" from nothing), but animate on every later toggle. Callers
  // that already own such a ref (My Drive) pass it in so the ref lifecycle
  // stays shared; standalone callers (Recent) get an internal one.
  const isInitialMount = isInitialMountProp ?? internalInitialMount;

  useEffect(() => {
    internalInitialMount.current = false;
  }, []);

  const baseSortOption = sortOption.replace(" desc", "");
  // Why: callers always pass a pre-translated fallbackLabel (e.g. "Sort");
  // the default prop is a plain 'Sort' safety fallback.
  const label = fallbackLabel;
  const currentSortLabel =
    options.find((opt) => opt.id === baseSortOption)?.label || label;

  return (
    <div className="relative">
      <div
        onClick={() => setShowSortMenu(!showSortMenu)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-all shadow-sm [&:active:not(:has(.arrow-btn:active))]:scale-95 cursor-pointer select-none"
      >
        <div
          className="arrow-btn p-1 -ml-1.5 rounded-md hover:bg-gray-200 dark:hover:bg-[#2e2f34] transition-transform active:scale-75 flex items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            if (sortOption.endsWith(" desc")) {
              onSortChange?.(sortOption.replace(" desc", ""));
            } else {
              onSortChange?.(sortOption + " desc");
            }
          }}
          title={t("sort.toggle_order", "Toggle Order")}
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
              className={`stroke-gray-400 ${isInitialMount.current ? (!sortOption.endsWith(" desc") ? "opacity-0" : "") : !sortOption.endsWith(" desc") ? "anim-drain-up" : "anim-fill-up"}`}
            >
              <path d="m3 8 4-4 4 4" />
              <path d="M7 4v16" />
            </g>

            {/* Blue UP Arrow */}
            <g
              className={`stroke-[#4285F4] ${isInitialMount.current ? (!sortOption.endsWith(" desc") ? "" : "opacity-0") : !sortOption.endsWith(" desc") ? "anim-fill-up" : "anim-drain-up"}`}
            >
              <path d="m3 8 4-4 4 4" />
              <path d="M7 4v16" />
            </g>

            {/* Gray DOWN Arrow (Inverse animated) — see the UP arrow note. */}
            <g
              className={`stroke-gray-400 ${isInitialMount.current ? (sortOption.endsWith(" desc") ? "opacity-0" : "") : sortOption.endsWith(" desc") ? "anim-drain-down" : "anim-fill-down"}`}
            >
              <path d="m21 16-4 4-4-4" />
              <path d="M17 20V4" />
            </g>

            {/* Blue DOWN Arrow */}
            <g
              className={`stroke-[#4285F4] ${isInitialMount.current ? (sortOption.endsWith(" desc") ? "" : "opacity-0") : sortOption.endsWith(" desc") ? "anim-fill-down" : "anim-drain-down"}`}
            >
              <path d="m21 16-4 4-4-4" />
              <path d="M17 20V4" />
            </g>
          </svg>
        </div>
        <div className="hidden sm:grid text-center pr-1">
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

      {showSortMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowSortMenu(false)}
          ></div>
          <div className="absolute right-0 mt-2 w-32 bg-white dark:bg-[#1a1b1e] rounded-xl shadow-lg p-1.5 flex flex-col gap-0.5 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
            {options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => {
                  const newOpt = opt.defaultDesc ? `${opt.id} desc` : opt.id;
                  onSortChange?.(newOpt);
                  setShowSortMenu(false);
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 text-sm transition-colors rounded-md hover:bg-gray-50 dark:hover:bg-[#25262a] hover:text-[#4285F4] dark:hover:text-[#4285F4] ${baseSortOption === opt.id ? "text-[#4285F4] font-medium" : "text-gray-700 dark:text-gray-300"}`}
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
