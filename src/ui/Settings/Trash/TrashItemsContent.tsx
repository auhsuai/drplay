import { Trash2, Check, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkeletonRowList } from "../../components/Skeleton";
import { TrashItemRow } from "../TrashItemRow";
import type { TrashedItem } from "../useTrashedFiles";
import type { TrashSortKey, TrashSortDirection } from "../sortTrashedItems";

export interface TrashItemsContentProps {
  items: TrashedItem[];
  isLoading: boolean;
  selectedIds: ReadonlySet<string>;
  restoringIds: ReadonlySet<string>;
  deletingIds: ReadonlySet<string>;
  allSelected: boolean;
  someSelected: boolean;
  sortKey: TrashSortKey;
  sortDirection: TrashSortDirection;
  onSortChange: (key: TrashSortKey) => void;
  onToggleItem: (id: string) => void;
  onToggleAll: () => void;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
}

// aria-sort value for one column header given the active key/direction.
// Columns that are not the active key report "none" (ARIA: a sortable column
// header declares a direction only while it owns the sort).
function ariaSortFor(
  key: TrashSortKey,
  sortKey: TrashSortKey,
  direction: TrashSortDirection,
): "ascending" | "descending" | "none" {
  if (key !== sortKey) return "none";
  return direction === "asc" ? "ascending" : "descending";
}

// Blue circular directional indicator shown on the active sort column
// (Google Drive pattern: small brand-blue disc, contrasting arrow). The
// arrow-up artwork is lucide's (lucide.dev/icons/arrow-up, ISC); the disc
// reuses the row's brand-primary token.
function SortIndicator({ direction }: { direction: TrashSortDirection }) {
  return (
    <span
      aria-hidden="true"
      className="flex w-[22px] h-[22px] shrink-0 items-center justify-center rounded-full bg-brand-primary text-white"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={direction === "asc" ? "" : "rotate-180"}
      >
        <path d="m5 12 7-7 7 7" />
        <path d="M12 19V5" />
      </svg>
    </span>
  );
}

// Read-only view of the trash list: loading skeleton, empty state, the sticky
// sortable header and the flat rows. Every mutation (restore/delete/selection)
// and the sort state itself stay in TrashScreen — this component only receives
// values and calls the handlers it is given.
export function TrashItemsContent({
  items,
  isLoading,
  selectedIds,
  restoringIds,
  deletingIds,
  allSelected,
  someSelected,
  sortKey,
  sortDirection,
  onSortChange,
  onToggleItem,
  onToggleAll,
  onRestore,
  onDelete,
}: TrashItemsContentProps) {
  const { t } = useTranslation();

  return (
    <div className="flex-1 overflow-y-auto bg-white dark:bg-[#121212]">
      {isLoading ? (
        // Skeleton rows mirror the flat TrashItemRow (h-12 rows with a
        // hairline divider): no stretch and no h-full on the container,
        // which divided the list height across rows and made them up to
        // ~2x taller on tall screens.
        <div role="status" aria-label={t("loading")} className="h-full">
          <SkeletonRowList
            rows={6}
            variant="trash"
            containerClassName="flex flex-col"
          />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 text-gray-500 flex flex-col items-center">
          <Trash2 className="w-16 h-16 mb-4 opacity-20" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-200">
            {t("settings.trash_empty")}
          </h3>
        </div>
      ) : (
        <>
          {/* Sticky header: the select-all bar EXTENDED with sortable column
              labels — a second sticky element would double the sticky offset
              for rows. Column width classes mirror TrashItemRow exactly
              (flex-1 / w-24 hidden sm:block / w-16) so header and rows align,
              and the header shares the row's px-3 + gap-3 grid. The trailing
              spacer reserves the row action cluster's width (2 × p-2 buttons
              + w-4 icons + gap-1) so the Size column's right edge lines up
              with the size values below it. */}
          <div className="sticky top-0 z-10 flex h-9 items-center gap-3 border-b border-gray-200 bg-white px-3 dark:border-[#2A2A2A] dark:bg-[#121212]">
            <label className="flex items-center gap-2 cursor-pointer shrink-0">
              <span className="relative inline-flex shrink-0">
                <input
                  ref={(el) => {
                    // Native partial state: checked stays false while only
                    // some rows are selected.
                    if (el) el.indeterminate = someSelected;
                  }}
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  className="peer appearance-none w-4 h-4 rounded border-2 border-gray-400 dark:border-gray-500 bg-white dark:bg-[#2a2b2f] checked:bg-brand-primary checked:border-brand-primary indeterminate:bg-brand-primary indeterminate:border-brand-primary cursor-pointer transition-colors"
                />
                <Check
                  className="absolute inset-0 m-auto w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none"
                  strokeWidth={3}
                />
                {someSelected && (
                  <Minus
                    className="absolute inset-0 m-auto w-3 h-3 text-white pointer-events-none"
                    strokeWidth={3}
                  />
                )}
              </span>
              <span className="text-xs font-medium text-gray-500">
                {allSelected
                  ? t("settings.trash_unselect_all")
                  : t("settings.trash_select_all")}
              </span>
            </label>
            {/* Sortable columns: aria-sort lives on a columnheader wrapper
                (ARIA reserves aria-sort for column/rowheader roles); the
                button inside is the keyboard-activatable control. */}
            <span
              role="columnheader"
              aria-sort={ariaSortFor("name", sortKey, sortDirection)}
              className="flex-1 min-w-0 flex"
            >
              <button
                type="button"
                onClick={() => {
                  onSortChange("name");
                }}
                className="flex-1 min-w-0 flex items-center gap-1 truncate text-left text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
              >
                <span className="truncate">{t("settings.trash_col_name")}</span>
                {sortKey === "name" && (
                  <SortIndicator direction={sortDirection} />
                )}
              </button>
            </span>
            <span
              role="columnheader"
              aria-sort={ariaSortFor("deletedAt", sortKey, sortDirection)}
              className="hidden sm:block w-24 shrink-0"
            >
              <button
                type="button"
                onClick={() => {
                  onSortChange("deletedAt");
                }}
                title={t("settings.trash_date_approximate")}
                className="flex w-full items-center gap-1 text-left text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
              >
                <span className="truncate">
                  {t("settings.trash_col_date_added")}
                </span>
                {sortKey === "deletedAt" && (
                  <SortIndicator direction={sortDirection} />
                )}
              </button>
            </span>
            <span
              role="columnheader"
              aria-sort={ariaSortFor("size", sortKey, sortDirection)}
              className="w-16 shrink-0"
            >
              <button
                type="button"
                onClick={() => {
                  onSortChange("size");
                }}
                className="flex w-full items-center justify-end gap-1 text-right text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
              >
                <span className="truncate">{t("settings.trash_col_size")}</span>
                {sortKey === "size" && (
                  <SortIndicator direction={sortDirection} />
                )}
              </button>
            </span>
            <span className="w-[68px] shrink-0" aria-hidden="true" />
          </div>
          {items.map((item) => (
            <TrashItemRow
              key={item.id}
              item={item}
              isSelected={selectedIds.has(item.id)}
              isRestoring={restoringIds.has(item.id)}
              isDeleting={deletingIds.has(item.id)}
              onToggle={onToggleItem}
              onRestore={onRestore}
              onDelete={onDelete}
            />
          ))}
        </>
      )}
    </div>
  );
}
