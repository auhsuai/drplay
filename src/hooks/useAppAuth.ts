import { useRef } from "react";
import { captureError } from "../utils/errorLog";
import { db } from "../db/db";
import { clearSessionState } from "../utils/sessionCleanup";
import {
  DB_NAV_STATE_KEY,
  LS_CURRENT_FOLDER_ID,
  LS_CURRENT_FOLDER_NAME,
  LS_FOLDER_HISTORY,
  LS_ROOT_FOLDER,
} from "../appUiState";
import { useAuth } from "./useAuth";

/**
 * App-level auth wiring: useAuth plus the logout cleanup callback, verbatim
 * from App.tsx. Returns setAppRootFolderRef so the drive-state hook (which
 * owns the real setter) can sync it in an effect — the ref bridges the TDZ:
 * the logout callback must not touch a `const` declared later in the
 * component body.
 */
export function useAppAuth() {
  const setAppRootFolderRef = useRef<(folderId: string | null) => void>(
    () => {},
  );

  const {
    isLoggedIn,
    accessToken,
    userProfile,
    handleLoginSuccess,
    handleLogout,
  } = useAuth(() => {
    try {
      localStorage.removeItem(LS_ROOT_FOLDER);
      localStorage.removeItem(LS_CURRENT_FOLDER_ID);
      localStorage.removeItem(LS_CURRENT_FOLDER_NAME);
      localStorage.removeItem(LS_FOLDER_HISTORY);
    } catch (err) {
      void captureError({
        level: "warn",
        source: "App",
        message: `logout-cleanup-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
        kind: "localstorage-cleanup-failed",
      });
    }
    db.syncState.delete(DB_NAV_STATE_KEY).catch(
      (e: unknown) =>
        void captureError({
          source: "App",
          message: `logout-cleanup-failed: ${e instanceof Error ? e.message : String(e)}`,
          kind: "logout-cleanup-failed",
        }),
    );
    clearSessionState();
    setAppRootFolderRef.current(null);
  });

  return {
    isLoggedIn,
    accessToken,
    userProfile,
    handleLoginSuccess,
    handleLogout,
    setAppRootFolderRef,
  };
}
