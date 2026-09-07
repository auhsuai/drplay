export const MORE_MENU_MODULE = "MoreMenu";
export const EVENT_LOCATE_FILE = "locate-file";

// Menu rows compact on mobile (IS_MOBILE): tighter padding, 13px text and a
// smaller bottom margin keep touch rows ~32px tall. Desktop must keep the
// original token strings byte-identical.
export function menuItemBaseClass(isMobile: boolean): string {
  return isMobile
    ? "w-full text-left px-2.5 py-1.5 text-[13px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-brand-primary rounded-md transition-all flex items-center gap-2 group mb-0.5"
    : "w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-brand-primary rounded-md transition-all flex items-center gap-2 group mb-1";
}

export function menuItemDeleteClass(isMobile: boolean): string {
  return isMobile
    ? "w-full text-left px-2.5 py-1.5 text-[13px] text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all flex items-center gap-2 group mb-0.5"
    : "w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all flex items-center gap-2 group mb-1";
}

// Shared row-icon sizing: 14px on mobile vs 16px on desktop, so raw lucide
// icons rendered outside MoreMenuItem match MoreMenuItem's default icon
// contract.
export function menuItemIconClass(isMobile: boolean): string {
  return isMobile
    ? "w-3.5 h-3.5 opacity-60 group-hover:opacity-100 transition-opacity"
    : "w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity";
}
export const MENU_ESTIMATED_HEIGHT_PX = 250; // estimated dropdown height used to decide open-up vs open-down

export type MoreMenuVariant = "default" | "playerbar" | "recent";
