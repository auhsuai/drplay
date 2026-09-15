import React, { useState, useEffect, useRef, useCallback } from "react";
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

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<"first" | "last">("first");

  const getMenuItems = useCallback((): HTMLElement[] => {
    const root = menuRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
  }, []);

  const focusMenuItemAt = useCallback(
    (index: number): void => {
      const items = getMenuItems();
      if (items.length === 0) return;
      const target = items[(index + items.length) % items.length];
      // Roving tabindex: exactly one item stays in the tab order.
      items.forEach((item) => {
        item.tabIndex = item === target ? 0 : -1;
      });
      target?.focus();
    },
    [getMenuItems],
  );

  // APG: focus moves to the first item whenever the menu opens — trigger
  // click or the optional trigger ArrowDown/ArrowUp.
  useEffect(() => {
    if (!showSortMenu) return;
    const position = pendingFocusRef.current;
    pendingFocusRef.current = "first";
    focusMenuItemAt(position === "last" ? -1 : 0);
  }, [showSortMenu, focusMenuItemAt]);

  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setShowSortMenu(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  return (
    <div className="relative">
      {/* Split control (APG menu button + axe nested-interactive): the arrow
          toggle is its own real <button>, never a focusable control nested
          inside the menu trigger. */}
      <div className="flex items-center bg-white dark:bg-[#1a1b1e] hover:bg-gray-50 dark:hover:bg-[#25262a] rounded-lg transition-all shadow-sm [&:active:not(:has(.arrow-btn:active))]:scale-95 select-none">
        <button
          type="button"
          title={t("sort.toggle_order")}
          aria-label={t("sort.toggle_order")}
          onClick={() => {
            if (sortOption.endsWith(" desc")) {
              onSortChange?.(sortOption.replace(" desc", ""));
            } else {
              onSortChange?.(sortOption + " desc");
            }
          }}
          className="arrow-btn ml-1.5 p-1 rounded-md hover:bg-gray-200 dark:hover:bg-[#2e2f34] transition-transform active:scale-75 flex items-center justify-center cursor-pointer"
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
        </button>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={showSortMenu}
          aria-label={t("sort.menu")}
          onClick={() => {
            setShowSortMenu(!showSortMenu);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            pendingFocusRef.current = e.key === "ArrowUp" ? "last" : "first";
            setShowSortMenu(true);
          }}
          className="flex items-center pl-1.5 pr-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none rounded-lg"
        >
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
        </button>
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
            ref={menuRef}
            data-testid="sort-menu"
            role="menu"
            aria-label={t("sort.menu")}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeMenu(true);
                return;
              }
              if (
                e.key !== "ArrowDown" &&
                e.key !== "ArrowUp" &&
                e.key !== "Home" &&
                e.key !== "End"
              ) {
                return;
              }
              e.preventDefault();
              const items = getMenuItems();
              if (items.length === 0) return;
              const current = items.indexOf(e.target as HTMLElement);
              if (e.key === "ArrowDown") {
                focusMenuItemAt(current < 0 ? 0 : current + 1);
              } else if (e.key === "ArrowUp") {
                focusMenuItemAt(current < 0 ? items.length - 1 : current - 1);
              } else if (e.key === "Home") {
                focusMenuItemAt(0);
              } else {
                focusMenuItemAt(items.length - 1);
              }
            }}
            className="absolute right-0 mt-2 min-w-full w-max bg-white dark:bg-[#1a1b1e] rounded-xl shadow-lg p-1.5 flex flex-col gap-0.5 z-50 animate-in fade-in slide-in-from-top-2 duration-200"
          >
            {options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="menuitemradio"
                aria-checked={baseSortOption === opt.id}
                onClick={() => {
                  const newOpt = opt.defaultDesc ? `${opt.id} desc` : opt.id;
                  onSortChange?.(newOpt);
                  closeMenu(true);
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 text-sm transition-colors rounded-md hover:bg-gray-50 dark:hover:bg-[#25262a] hover:text-brand-text dark:hover:text-brand-text ${baseSortOption === opt.id ? "text-brand-text font-medium" : "text-gray-700 dark:text-gray-300"}`}
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
