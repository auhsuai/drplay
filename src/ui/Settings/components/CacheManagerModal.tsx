import { useEffect, useState } from "react";
import { X, LoaderCircle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  clearAppCache,
  getCacheSizes,
  CACHE_CATEGORY_LABELS,
  type CacheCategoryId,
} from "../../../utils/cache";
import { formatBytes } from "../../../utils/formatBytes";
import { showErrorToast, showSuccessToast } from "../../../utils/simpleToast";
import { captureError } from "../../../utils/errorLog";

const CACHE_MANAGER_MODULE = "CacheManagerModal";

// Fixed row order — labels come from CACHE_CATEGORY_LABELS (single source).
const CATEGORY_IDS: CacheCategoryId[] = [
  "metadata",
  "files",
  "covers",
  "prefetch",
];

const ALL_SELECTED: Set<CacheCategoryId> = new Set(CATEGORY_IDS);

function nullSizes(): Record<CacheCategoryId, number | null> {
  return { metadata: null, files: null, covers: null, prefetch: null };
}

interface CacheManagerModalProps {
  open: boolean;
  onClose: () => void;
}

export function CacheManagerModal({ open, onClose }: CacheManagerModalProps) {
  const { t } = useTranslation();
  // Sizes are null until the fetch resolves; a null slot renders a spinner so
  // rows stay fixed and never jump while estimates are loading.
  const [sizes, setSizes] =
    useState<Record<CacheCategoryId, number | null>>(nullSizes);
  const [selected, setSelected] = useState<Set<CacheCategoryId>>(ALL_SELECTED);
  const [clearing, setClearing] = useState(false);

  // Reset sizes/selection when the modal (re)opens — adjusted during render
  // (React "adjusting state during render" pattern) instead of inside the
  // fetch effect, so the re-fetch never synchronously calls setState in an
  // effect (react-hooks/set-state-in-effect).
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    if (open) {
      setSizes(nullSizes());
      setSelected(ALL_SELECTED);
    }
  }

  // Sizes are re-fetched on every open so the numbers never go stale after a
  // previous clear; every category defaults to checked unless the user opts
  // out (clear-all is the primary use case).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getCacheSizes()
      .then((results) => {
        if (cancelled) return;
        setSizes({
          metadata: results.find((r) => r.id === "metadata")?.bytes ?? 0,
          files: results.find((r) => r.id === "files")?.bytes ?? 0,
          covers: results.find((r) => r.id === "covers")?.bytes ?? 0,
          prefetch: results.find((r) => r.id === "prefetch")?.bytes ?? 0,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Per-category estimators already swallow their own failures, but a
        // hard rejection here still degrades to zeroed sizes (Clear stays
        // usable) instead of an unhandled promise rejection.
        void captureError({
          level: "error",
          source: CACHE_MANAGER_MODULE,
          message: `load-cache-sizes-failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        setSizes({ metadata: 0, files: 0, covers: 0, prefetch: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape must not close mid-clear (same guard as the overlay click).
      if (e.key === "Escape" && !clearing) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose, clearing]);

  if (!open) return null;

  const toggleCategory = (id: CacheCategoryId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleClear = async () => {
    if (selected.size === 0 || clearing) return;
    setClearing(true);
    try {
      await clearAppCache([...selected]);
      showSuccessToast(t("settings.clear_cache_success"));
      onClose();
    } catch {
      // clearAppCache already logs each failing category via captureError;
      // here we only surface the aggregated message and keep the modal open
      // so the user can retry with a narrower selection.
      showErrorToast(t("settings.clear_cache_error"));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      data-testid="cache-manager-overlay"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget && !clearing) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="cache-manager-modal"
        className="bg-white dark:bg-[#202124] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">
            {t("settings.clear_cache")}
          </h3>
          <button
            onClick={onClose}
            disabled={clearing}
            aria-label={t("settings.close")}
            className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-1 rounded-full transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-col">
          {CATEGORY_IDS.map((id) => (
            <label
              key={id}
              className="flex items-center justify-between gap-3 py-2.5 cursor-pointer select-none"
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="relative inline-flex shrink-0">
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    onChange={() => {
                      toggleCategory(id);
                    }}
                    className="peer appearance-none w-4 h-4 rounded border-2 border-gray-400 dark:border-gray-500 bg-white dark:bg-[#2a2b2f] checked:bg-brand-primary checked:border-brand-primary cursor-pointer transition-colors"
                  />
                  <Check
                    className="absolute inset-0 m-auto w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none"
                    strokeWidth={3}
                  />
                </span>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                  {t(`cache.label.${id}`, CACHE_CATEGORY_LABELS[id])}
                </span>
              </span>
              <span className="w-14 shrink-0 flex items-center justify-end">
                {sizes[id] === null ? (
                  <LoaderCircle
                    data-testid="size-spinner"
                    className="w-3.5 h-3.5 animate-spin text-gray-400"
                  />
                ) : (
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {formatBytes(sizes[id])}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3 mt-2">
          <button
            onClick={onClose}
            disabled={clearing}
            className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
          >
            {t("menu.cancel")}
          </button>
          <button
            onClick={() => {
              void handleClear();
            }}
            disabled={selected.size === 0 || clearing}
            className="px-5 py-2.5 text-sm font-medium text-white bg-brand-primary hover:bg-brand-hover rounded-xl transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {clearing && <LoaderCircle className="w-4 h-4 animate-spin" />}
            {t("settings.clear_cache_btn")}
          </button>
        </div>
      </div>
    </div>
  );
}
