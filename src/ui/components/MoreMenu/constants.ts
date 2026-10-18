export const MORE_MENU_MODULE = "MoreMenu";
export const EVENT_LOCATE_FILE = "locate-file";

export const MENU_ITEM_BASE_CLASS =
  "w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-brand-text rounded-md transition-all flex items-center gap-2 group mb-1";
/**
 * Same row, tighter vertical rhythm (py-1.5 / mb-0.5 instead of py-2 / mb-1) so
 * the video menu fits fewer pixels without becoming cramped. Every colour, the
 * hover tint, the radius and the icon/label layout are IDENTICAL to
 * `MENU_ITEM_BASE_CLASS` — only the two spacing utilities differ. It is a
 * separate constant on purpose: `MENU_ITEM_BASE_CLASS` is shared by every other
 * menu, so editing it there would restyle all of them.
 */
export const VIDEO_MENU_ITEM_CLASS =
  "w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-brand-text rounded-md transition-all flex items-center gap-2 group mb-0.5";
export const MENU_ITEM_DELETE_CLASS =
  "w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all flex items-center gap-2 group mb-1";
export const MENU_ESTIMATED_HEIGHT_PX = 250; // estimated dropdown height used to decide open-up vs open-down

export type MoreMenuVariant =
  "default" | "playerbar" | "recent" | "queue" | "playlist" | "sidebarPlaylist";
