import { useFolderNavigation } from "./useFolderNavigation";
import { useFolderSearch } from "./useFolderSearch";

export function useFolderPicker({
  token,
  initialFolderId,
  initialFolderName,
  initialFolderHistory,
  allowEscapeRoot,
  resolvedAppRoot,
}: {
  token: string;
  initialFolderId: string;
  initialFolderName?: string | undefined;
  initialFolderHistory: { id: string; name: string }[];
  allowEscapeRoot?: boolean;
  resolvedAppRoot: string | null;
}) {
  const {
    folders,
    isLoading,
    currentFolderId,
    currentFolderName,
    folderHistory,
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
  } = useFolderNavigation({
    token,
    initialFolderId,
    initialFolderName,
    initialFolderHistory,
    allowEscapeRoot,
    resolvedAppRoot,
  });

  const {
    searchQuery,
    setSearchQuery,
    filteredFolders,
    apiSearchResults,
    isSearchingApi,
    searchInputRef,
  } = useFolderSearch({ token, folders, currentFolderId });

  return {
    folders,
    isLoading,
    searchQuery,
    setSearchQuery,
    filteredFolders,
    apiSearchResults,
    isSearchingApi,
    currentFolderId,
    currentFolderName,
    folderHistory,
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
    searchInputRef,
  };
}
