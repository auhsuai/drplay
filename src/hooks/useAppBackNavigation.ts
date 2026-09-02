import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import {
  handleGlobalBack,
  useHardwareBack,
  createDoubleBackExit,
  DOUBLE_BACK_EXIT_MS,
  registerNativeBackHandler,
} from "./useHardwareBack";
import { IS_MOBILE } from "../utils/platform";
import { showSuccessToast } from "../utils/simpleToast";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB, TABS } from "../utils/driveConstants";
import type { TabKey } from "../types";
import type { useDrive } from "./useDrive";

type UseDriveReturn = ReturnType<typeof useDrive>;

export interface UseAppBackNavigationParams {
  activeTab: TabKey;
  handleTabChange: (tab: TabKey) => void;
  t: TFunction;
  folderHistory: UseDriveReturn["folderHistory"];
  handleBack: UseDriveReturn["handleBack"];
  appRootFolder: UseDriveReturn["appRootFolder"];
  currentFolderId: UseDriveReturn["currentFolderId"];
  setCurrentFolderId: UseDriveReturn["setCurrentFolderId"];
  setCurrentFolderName: UseDriveReturn["setCurrentFolderName"];
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  showFolderSelection: boolean;
  setShowFolderSelection: (show: boolean) => void;
  showTrashScreen: boolean;
  setShowTrashScreen: (show: boolean) => void;
  showRateLimitModal: boolean;
  setShowRateLimitModal: (show: boolean) => void;
  isNowPlayingOpen: boolean;
  setIsNowPlayingOpen: (open: boolean) => void;
}

/**
 * All hardware/native back-button wiring for App, verbatim from App.tsx.
 * The registration ORDER of the useHardwareBack calls below is load-bearing:
 * overlay-close handlers run in LIFO order, so this hook must keep them
 * exactly in this sequence.
 */
export function useAppBackNavigation({
  activeTab,
  handleTabChange,
  t,
  folderHistory,
  handleBack,
  appRootFolder,
  currentFolderId,
  setCurrentFolderId,
  setCurrentFolderName,
  isSidebarOpen,
  setIsSidebarOpen,
  showFolderSelection,
  setShowFolderSelection,
  showTrashScreen,
  setShowTrashScreen,
  showRateLimitModal,
  setShowRateLimitModal,
  isNowPlayingOpen,
  setIsNowPlayingOpen,
}: UseAppBackNavigationParams) {
  // Hardware back button (mobile only): overlay-close handlers run in LIFO
  // order — the LAST registered (highest priority) runs first. Priority:
  // rate-limit modal > trash > folder selection > sidebar > My Drive folder
  // up. All handlers are no-ops on desktop (useHardwareBack skips
  // registration when inactive, and the native back subscriber below
  // early-returns on !IS_MOBILE).
  // Task 14 mobile-polish: My Drive folder drill-down is a navigation layer
  // ABOVE the exit chain — back on a subfolder pops one history level instead
  // of jumping straight to double-back-to-exit. Registered FIRST (checked
  // last) so overlay closes always win; gate is the store's drill-down state
  // (currentFolderId ≠ root on the My Drive tab).
  useHardwareBack(
    () => {
      if (folderHistory.length > 0) {
        handleBack();
      } else {
        // Restore/deep-link edge: a subfolder with empty history (locate-file
        // normally rebuilds it) — jump straight to the configured root.
        setCurrentFolderId(appRootFolder || ROOT_FOLDER_ID);
        setCurrentFolderName(MY_DRIVE_TAB);
      }
      return true;
    },
    activeTab === TABS.myDrive &&
      currentFolderId !== (appRootFolder || ROOT_FOLDER_ID),
  );

  useHardwareBack(() => {
    setIsSidebarOpen(false);
    return true;
  }, isSidebarOpen);

  useHardwareBack(() => {
    setShowFolderSelection(false);
    return true;
  }, showFolderSelection);

  useHardwareBack(() => {
    setShowTrashScreen(false);
    return true;
  }, showTrashScreen);

  useHardwareBack(() => {
    setShowRateLimitModal(false);
    return true;
  }, showRateLimitModal);

  // NowPlaying closes ABOVE every other layer. Declared LAST so its effect
  // flushes after the folder-up handler on every render (effects run in
  // declaration order inside a component) and LIFO always checks it first —
  // back with NowPlaying open in a drill-down subfolder closes the overlay
  // instead of popping folder history. Deliberately NOT memoized: the sibling
  // handlers are inline too, and re-registering last on each render is what
  // keeps this handler on top of the stack.
  useHardwareBack(() => {
    setIsNowPlayingOpen(false);
    return true;
  }, isNowPlayingOpen);

  // Android hardware back button via Tauri's official onBackButtonPress event
  // (2.9+) — each native press fires the chain directly, so no synthetic
  // history entries are pushed anymore. Back order: registered overlay stack
  // (incl. NowPlaying, registered last → top of LIFO) → any non-Home tab →
  // Home → double-back-to-exit (Android convention: hint toast + 2s window
  // before the root press exits). Runs ONLY on mobile — desktop keeps native
  // window history and never subscribes.
  const navStateRef = useRef({
    activeTab,
    handleTabChange,
    t,
  });
  useEffect(() => {
    navStateRef.current = { activeTab, handleTabChange, t };
  }, [activeTab, handleTabChange, t]);

  useEffect(() => {
    if (!IS_MOBILE) return;

    // Task 9 mobile-polish: Android "Press back again to exit" convention —
    // at the root the FIRST back press shows a hint toast and arms a 2s
    // window; a second press inside the window exits. windowMs matches the
    // platform convention (2000ms). onArm/onExit read live state via the ref
    // so this mount-once effect never goes stale.
    const doubleBack = createDoubleBackExit({
      windowMs: DOUBLE_BACK_EXIT_MS,
      onArm: () => {
        showSuccessToast(navStateRef.current.t("back.press_again_to_exit"));
      },
      onExit: () => {
        // plugin-process exit(0) is the documented Tauri v2 way to exit on
        // Android; the WebView's own window.close() would be a no-op there
        // (Chromium only lets scripts close windows they opened), so it stays
        // as the last-resort fallback.
        exit(0).catch(() => {
          getCurrentWindow()
            .close()
            .catch(() => {
              window.close();
            });
        });
      },
    });

    // Task 9 mobile-polish upgrade: back now arrives via the native
    // onBackButtonPress event instead of a popstate listener. The chain is
    // identical to the old pushState hack — handleGlobalBack first (registered
    // overlay stack, NowPlaying included), then tab → Home, then
    // double-back-exit.
    const unregisterBack = registerNativeBackHandler(() => {
      if (handleGlobalBack()) return;

      const state = navStateRef.current;
      let handled = false;

      if (state.activeTab !== TABS.home) {
        state.handleTabChange(TABS.home);
        handled = true;
      }

      if (!handled) {
        // Root (Home): the press arms the 2s double-back window (onArm fires
        // the hint toast); a second press inside the window takes the exit
        // path via onExit.
        doubleBack.handleBack();
      }
    });

    return () => {
      unregisterBack();
      doubleBack.disarm();
    };
  }, []);
}
