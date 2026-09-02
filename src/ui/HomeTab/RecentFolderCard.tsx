import { Folder } from "lucide-react";
import type { FolderVisitEntry } from "../../utils/history";
import { IS_MOBILE } from "../../utils/platform";
import { useTranslation } from "react-i18next";

// One "Jump Back In" folder card, extracted verbatim from HomeTab.tsx.
// IS_MOBILE is a module constant per page load: the snap-start wrapper only
// exists on mobile — the desktop DOM stays byte-identical.
export function RecentFolderCard({
  folder,
  onOpenFolder,
}: {
  folder: FolderVisitEntry;
  onOpenFolder: (id: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const card = (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        onOpenFolder(folder.id, folder.name);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenFolder(folder.id, folder.name);
        }
      }}
      className="p-3.5 rounded-2xl transition-all duration-300 cursor-pointer flex items-center gap-4 active:scale-[0.98] group w-full bg-[#F8F9FA] dark:bg-[#202124] hover:bg-white dark:hover:bg-[#2a2b2f] hover:shadow-lg hover:shadow-black/5 hover:-translate-y-1"
    >
      <div className="relative w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-amber-100 dark:bg-amber-900/30 text-amber-500">
        <Folder className="w-6 h-6" fill="currentColor" />
      </div>
      <div className="overflow-hidden flex-1 flex flex-col justify-center">
        <h3 className="font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 text-gray-800 dark:text-gray-200 group-hover:text-brand-primary">
          {folder.name}
        </h3>
        <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
          <span className="truncate">{t("drive.folders")}</span>
        </div>
      </div>
    </div>
  );
  return IS_MOBILE ? (
    <div className="shrink-0 snap-start w-56">{card}</div>
  ) : (
    card
  );
}
