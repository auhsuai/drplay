import { Trash2, Check, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkeletonRowList } from "../../components/Skeleton";
import { TrashItemRow } from "../TrashItemRow";
import type { TrashedItem } from "../useTrashedFiles";

export interface TrashItemsContentProps {
  items: TrashedItem[];
  isLoading: boolean;
  selectedIds: ReadonlySet<string>;
  restoringIds: ReadonlySet<string>;
  deletingIds: ReadonlySet<string>;
  allSelected: boolean;
  someSelected: boolean;
  onToggleItem: (id: string) => void;
  onToggleAll: () => void;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

// Read-only view of the trash list: loading skeleton, empty state and the
// flat rows. Every mutation (restore/delete/selection) stays in TrashScreen —
// this component only receives values and calls the handlers it is given.
export function TrashItemsContent({
  items,
  isLoading,
  selectedIds,
  restoringIds,
  deletingIds,
  allSelected,
  someSelected,
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
          <div className="sticky top-0 z-10 flex h-9 items-center border-b border-gray-200 bg-white px-3 dark:border-[#2A2A2A] dark:bg-[#121212]">
            <label className="flex items-center gap-2 cursor-pointer">
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
