import { useEffect, useState } from "react";
import { ArrowLeft, HardDrive, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { ROOT_FOLDER_KEY } from "../../utils/storageKeys";
import { captureError } from "../../utils/errorLog";
import { useFolderPicker } from "./useFolderPicker";
import { FolderGrid } from "./FolderGrid";
import { FolderBreadcrumb } from "./FolderBreadcrumb";
import { FolderSearchInput } from "./FolderSearchInput";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

interface FolderSelectionScreenProps {
  token: string;
  onSelectFolder: (folderId: string) => void;
  onCancel?: (() => void) | undefined; // Optional cancel for when called from Settings
  initialFolderId?: string;
  initialFolderName?: string | undefined;
  initialFolderHistory?: { id: string; name: string }[] | undefined;
  title?: string;
  subtitle?: string;
  appRootFolder?: string | null;
  allowEscapeRoot?: boolean;
}

export function FolderSelectionScreen({
  token,
  onSelectFolder,
  onCancel,
  initialFolderId = ROOT_FOLDER_ID,
  initialFolderName,
  initialFolderHistory = [],
  title,
  subtitle,
  appRootFolder,
  allowEscapeRoot = false,
}: FolderSelectionScreenProps) {
  const { t } = useTranslation();

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Empty states"): the folder
  // data comes from useFolderPicker (not settable from outside), so a local
  // flag overrides the props handed to FolderGrid instead. onDebugEvent
  // no-ops in production builds; the listener never runs there.
  const [debugForceEmpty, setDebugForceEmpty] = useState(false);

  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.FOLDERS_EMPTY, () => {
      setDebugForceEmpty(true);
    });
  }, []);

  // Resolve appRootFolder from props or localStorage.
  // localStorage access can throw SecurityError (storage blocked by policy —
  // see MDN Window.localStorage), so the read is guarded and falls back to
  // null (same as a missing key).
  let storedAppRoot: string | null = null;
  try {
    storedAppRoot = localStorage.getItem(ROOT_FOLDER_KEY);
  } catch (err) {
    void captureError({
      level: "warn",
      source: "FolderSelectionScreen",
      message: `root-folder-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
  }
  const resolvedAppRoot = appRootFolder || storedAppRoot;

  const {
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
  } = useFolderPicker({
    token,
    initialFolderId,
    initialFolderName,
    initialFolderHistory,
    allowEscapeRoot,
    resolvedAppRoot,
  });

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget && onCancel) onCancel();
      }}
    >
      <div className="bg-white dark:bg-[#121212] w-full max-w-3xl h-[75vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
              <HardDrive className="text-brand-primary w-6 h-6" />
              {title || t("folder_selection.select_root")}
            </h1>
            <p className="text-xs text-gray-500 mt-1">
              {subtitle || t("folder_selection.select_music_folder")}
            </p>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                ></path>
              </svg>
            </button>
          )}
        </div>

        {/* Toolbar / Breadcrumb / Search */}
        <div className="px-6 py-3 flex items-center gap-2 shrink-0 bg-gray-50/50 dark:bg-[#1a1b1e]/50">
          <button
            onClick={() => {
              void handleBack();
            }}
            disabled={
              folderHistory.length === 0 &&
              (currentFolderId === ROOT_FOLDER_ID ||
                (!allowEscapeRoot && currentFolderId === resolvedAppRoot))
            }
            className="p-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4 text-gray-700 dark:text-gray-300" />
          </button>

          <FolderBreadcrumb
            folderHistory={folderHistory}
            currentFolderName={currentFolderName}
            onBreadcrumbClick={handleBreadcrumbClick}
          />

          <FolderSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            inputRef={searchInputRef}
          />
        </div>

        {/* Folder List */}
        <FolderGrid
          isLoading={debugForceEmpty ? false : isLoading}
          isSearchingApi={isSearchingApi}
          searchQuery={searchQuery}
          filteredFolders={debugForceEmpty ? [] : filteredFolders}
          apiSearchResults={apiSearchResults}
          onOpenFolder={handleOpenFolder}
        />

        {/* Footer Actions */}
        <div className="px-6 py-4 flex items-center justify-end gap-3 shrink-0">
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              {t("folder_selection.cancel")}
            </button>
          )}
          <button
            onClick={() => {
              onSelectFolder(currentFolderId);
            }}
            className="flex items-center gap-2 bg-brand-primary hover:bg-brand-hover text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all transform active:scale-[0.98] shadow-sm"
          >
            <Check className="w-4 h-4" />
            {t("folder_selection.choose_folder")}
          </button>
        </div>
      </div>
    </div>
  );
}
