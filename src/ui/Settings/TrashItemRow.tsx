import {
  RefreshCw,
  LoaderCircle,
  FileHeadphone,
  Folder,
  Check,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { FOLDER_MIME } from "../../utils/driveApi";
import type { TrashedItem } from "./useTrashedFiles";

interface TrashItemRowProps {
  item: TrashedItem;
  isSelected: boolean;
  isSelectionMode: boolean;
  isRestoring: boolean;
  onToggle: (id: string) => void;
  onRestore: (id: string) => Promise<void>;
}

export function TrashItemRow({
  item,
  isSelected,
  isSelectionMode,
  isRestoring,
  onToggle,
  onRestore,
}: TrashItemRowProps) {
  const { t } = useTranslation();
  const isFolder = item.mimeType === FOLDER_MIME;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`flex items-center justify-between p-3 rounded-xl transition-colors ${
        isSelectionMode ? "cursor-pointer" : ""
      } ${
        isSelected
          ? "bg-brand-primary/10 border border-brand-primary/30"
          : "bg-gray-50 dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] border border-transparent"
      }`}
      onClick={() => {
        if (isSelectionMode) onToggle(item.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (isSelectionMode) onToggle(item.id);
        }
      }}
    >
      <div className="flex items-center gap-3 overflow-hidden">
        {isSelectionMode && (
          <div
            className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
              isSelected
                ? "bg-brand-primary border-brand-primary"
                : "border-gray-300 dark:border-gray-600 bg-white dark:bg-black/20"
            }`}
          >
            {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
          </div>
        )}
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isFolder ? "bg-amber-100 dark:bg-amber-900/30 text-amber-500" : "bg-brand-primary/10 text-brand-primary"}`}
        >
          {isFolder ? (
            <Folder className="w-5 h-5" fill="currentColor" />
          ) : (
            <FileHeadphone className="w-5 h-5" />
          )}
        </div>
        <div className="overflow-hidden">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate max-w-[250px] sm:max-w-sm">
            {item.name}
          </h4>
        </div>
      </div>
      {!isSelectionMode && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void onRestore(item.id);
          }}
          disabled={isRestoring}
          className="px-4 py-1.5 text-xs font-semibold text-green-600 bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 shrink-0"
        >
          {isRestoring ? (
            <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">{t("settings.restore")}</span>
        </button>
      )}
    </div>
  );
}
