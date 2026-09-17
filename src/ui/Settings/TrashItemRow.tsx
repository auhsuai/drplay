import {
  RefreshCw,
  LoaderCircle,
  Music,
  Folder,
  Trash2,
  Check,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { FOLDER_MIME } from "../../utils/driveApi";
import { formatBytes } from "../../utils/formatBytes";

// getTrashedFiles requests size/modifiedTime/trashedTime and passes them
// through, so rows show them when present. trashedTime is only populated for
// shared drives; My Drive rows show an approximate date via modifiedTime.
export interface TrashItemData {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  trashedTime?: string;
}

interface TrashItemRowProps {
  item: TrashItemData;
  isSelected: boolean;
  isRestoring: boolean;
  isDeleting: boolean;
  onToggle: (id: string) => void;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

// Drive returns sizes as strings (int64); folders have none. Malformed values
// fall back to "—" instead of formatBytes' "0 B".
function formatSize(size?: string): string {
  if (size === undefined || size === "") return "—";
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return "—";
  return formatBytes(bytes);
}

// trashedTime is only populated inside shared drives, so My Drive falls back to
// modifiedTime (Drive bumps it when the file is trashed via PATCH).
function formatDeletedDate(item: TrashItemData): string {
  const raw = item.trashedTime ?? item.modifiedTime;
  if (raw === undefined || raw === "") return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

export function TrashItemRow({
  item,
  isSelected,
  isRestoring,
  isDeleting,
  onToggle,
  onRestore,
  onDelete,
}: TrashItemRowProps) {
  const { t } = useTranslation();
  const isFolder = item.mimeType === FOLDER_MIME;
  const isBusy = isRestoring || isDeleting;
  return (
    <div
      data-testid="trash-row"
      className={`group flex h-12 items-center gap-3 border-b border-gray-200 px-3 transition-colors last:border-b-0 dark:border-[#2A2A2A] ${
        isSelected
          ? "bg-brand-primary/10"
          : "hover:bg-gray-50 dark:hover:bg-white/5"
      }`}
    >
      <span className="relative inline-flex shrink-0">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => {
            onToggle(item.id);
          }}
          aria-label={item.name}
          className="peer appearance-none w-4 h-4 rounded border-2 border-gray-400 dark:border-gray-500 bg-white dark:bg-[#2a2b2f] checked:bg-brand-primary checked:border-brand-primary cursor-pointer transition-colors"
        />
        <Check
          className="absolute inset-0 m-auto w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none"
          strokeWidth={3}
        />
      </span>
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isFolder ? "bg-amber-100 dark:bg-amber-900/30 text-amber-500" : "bg-brand-primary/10 text-brand-text"}`}
      >
        {isFolder ? (
          <Folder className="w-4 h-4" fill="currentColor" />
        ) : (
          <Music className="w-4 h-4" />
        )}
      </div>
      <p className="flex-1 min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
        {item.name}
      </p>
      <span className="hidden sm:block w-24 shrink-0 text-xs text-gray-500 tabular-nums">
        {formatDeletedDate(item)}
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-gray-500 tabular-nums">
        {formatSize(item.size)}
      </span>
      {/* Revealed on hover or keyboard focus; touch devices use the checkbox
          + bulk toolbar instead (no hover available). */}
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          onClick={() => {
            void onRestore(item.id);
          }}
          disabled={isBusy}
          title={t("settings.restore")}
          aria-label={t("settings.restore")}
          className="p-2 rounded-full text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-50 transition-colors"
        >
          {isRestoring ? (
            <LoaderCircle className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </button>
        <button
          onClick={() => {
            void onDelete(item.id);
          }}
          disabled={isBusy}
          title={t("settings.trash_delete_item")}
          aria-label={t("settings.trash_delete_item")}
          className="p-2 rounded-full text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition-colors"
        >
          {isDeleting ? (
            <LoaderCircle className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}
