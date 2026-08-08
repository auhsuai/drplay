export const MORE_MENU_MODULE = "MoreMenu";
export const EVENT_LOCATE_FILE = "locate-file";

// Monotonic upload-status version: bumped on every uploadManager notify so the
// menu re-renders and re-derives isUploading() for the currently targeted item.
// Module-level (same pattern as MainContent's VirtualizedSongList) so a menu
// remounted mid-upload still starts from the latest version —
// useSyncExternalStore re-reads the snapshot right after subscribing.
let uploadStatusVersion = 0;
export const getUploadStatusVersion = (): number => uploadStatusVersion;
export const bumpUploadStatusVersion = (): void => {
  uploadStatusVersion += 1;
};

export const MENU_ITEM_BASE_CLASS =
  "w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1";
export const MENU_ITEM_DELETE_CLASS =
  "w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all flex items-center gap-2 group mb-1";
// Applied when the targeted item is still uploading: actions must stay
// visible (the user sees why they are blocked) but must not be clickable.
export const MENU_ITEM_UPLOADING_BLOCKED_CLASS =
  " disabled:opacity-40 disabled:cursor-not-allowed";
export const MENU_ESTIMATED_HEIGHT_PX = 250; // estimated dropdown height used to decide open-up vs open-down

export type MoreMenuVariant = "default" | "playerbar" | "recent";
