import { Search, LoaderCircle, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SkeletonRowList } from "../components/Skeleton";
import { FolderCard } from "./FolderCard";
import type { FolderItem } from "./folderSelectionHelpers";

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
        // The folder list is a definite-height flex child (dialog
        // h-[75vh] flex-col), so h-full resolves and the stretch
        // skeleton fills the whole region instead of leaving a blank
        // band (RC-C).
        <div role="status" aria-label={t("loading")} className="p-6 h-full">
          <SkeletonRowList
            rows={6}
            variant="folder"
            containerClassName="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 h-full auto-rows-fr"
          />
        </div>
      ) : searchQuery.trim() &&
        filteredFolders.length === 0 &&
        apiSearchResults.length === 0 &&
        !isSearchingApi ? (
        <div className="text-center py-20 text-gray-500">
          <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <h3 className="text-lg font-medium mb-1 text-gray-900 dark:text-gray-200">
            {t("drive.no_folders")}
          </h3>
        </div>
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
        <div className="text-center py-20 text-gray-500">
          <Folder className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <h3 className="text-lg font-medium mb-1 text-gray-900 dark:text-gray-200">
            {t("drive.no_folders")}
          </h3>
        </div>
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
