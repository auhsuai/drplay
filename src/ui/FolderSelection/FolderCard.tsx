import { Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FolderItem } from "./folderSelectionHelpers";

export function FolderCard({
  folder,
  onClick,
}: {
  folder: FolderItem;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="p-4 rounded-xl bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md hover:-translate-y-1 transition-all duration-300 cursor-pointer group flex items-center gap-4"
    >
      <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-amber-100 dark:bg-amber-900/30 text-amber-500">
        <Folder className="w-6 h-6" fill="currentColor" />
      </div>
      <div className="overflow-hidden flex-1">
        <h3 className="font-semibold text-gray-800 dark:text-gray-200 group-hover:text-[#4285F4] transition-colors truncate">
          {folder.name}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {t("drive.folders")}
        </p>
      </div>
    </div>
  );
}
