import { Search, LoaderCircle, Folder, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkeletonRowList } from "../components/Skeleton";
import { FolderCard } from "./FolderCard";
import type { FolderItem } from "./folderSelectionHelpers";

function EmptyState({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="text-center py-20 text-gray-500">
      <Icon className="w-12 h-12 mx-auto mb-3 opacity-30" />
      <h3 className="text-lg font-medium mb-1 text-gray-900 dark:text-gray-200">
        {label}
      </h3>
    </div>
  );
}

export function FolderGrid({
  isLoading,
  isSearchingApi,
  searchQuery,
  filteredFolders,
  apiSearchResults,
  onOpenFolder,
}: {
  isLoading: boolean;
  isSearchingApi: boolean;
  searchQuery: string;
  filteredFolders: FolderItem[];
  apiSearchResults: FolderItem[];
  onOpenFolder: (folderId: string, folderName: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 overflow-y-auto p-6 bg-white dark:bg-[#121212]">
      {isLoading && !isSearchingApi ? (
        // Skeleton container mirrors the real grid classes (see the two
        // branches below) — no h-full/auto-rows-fr, which would stretch each
        // row to split the list height and make items ~3x taller than a card.
        <div role="status" aria-label={t("loading")} className="h-full">
          <SkeletonRowList
            rows={6}
            variant="folder"
            containerClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
          />
        </div>
      ) : searchQuery.trim() &&
        filteredFolders.length === 0 &&
        apiSearchResults.length === 0 &&
        !isSearchingApi ? (
        // Search-empty ≠ folder-empty: "No folders here." implied the folder
        // is empty, but it may be full of folders that simply do not match.
        <EmptyState
          icon={Search}
          label={t("folder_selection.no_matching_folders")}
        />
      ) : searchQuery.trim() &&
        (apiSearchResults.length > 0 || isSearchingApi) ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredFolders.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              onClick={() => {
                onOpenFolder(folder.id, folder.name);
              }}
            />
          ))}
          {filteredFolders.length > 0 && (
            <div className="col-span-full text-[11px] font-bold text-gray-400 uppercase tracking-wider pt-2 pb-1">
              {t("folder_selection.from_subfolders")}
            </div>
          )}
          {apiSearchResults.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              onClick={() => {
                onOpenFolder(folder.id, folder.name);
              }}
            />
          ))}
          {isSearchingApi && (
            <div className="col-span-full flex items-center justify-center gap-2 py-4 text-sm text-gray-400">
              <LoaderCircle className="w-4 h-4 animate-spin" />
              {t("folder_selection.searching_deeper")}
            </div>
          )}
        </div>
      ) : !searchQuery.trim() && filteredFolders.length === 0 && !isLoading ? (
        <EmptyState icon={Folder} label={t("drive.no_folders")} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredFolders.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              onClick={() => {
                onOpenFolder(folder.id, folder.name);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
