import { useTranslation } from "react-i18next";
import { RootFolderSetupFlow } from "./FolderSelection/RootFolderSetupFlow";
import { RootFolderSetupShell } from "./FolderSelection/rootFolderSetup/RootFolderSetupShell";
import { PRIMARY_BUTTON_CLASS } from "./components/folderDialogButtonStyles";
import type { RootFolder } from "../utils/rootFolders";

interface FolderSelectionGateProps {
  isLoggedIn: boolean;
  isHydrated: boolean;
  appRootFolder: string | null;
  showFolderSelection: boolean;
  token: string | null;
  rootFolders: RootFolder[];
  onCommitRoots: (roots: RootFolder[]) => Promise<boolean>;
  onDone: () => void;
  onCancel: (() => void) | undefined;
  /** Remote config could not be read and no local roots exist. */
  configError: "unavailable" | null;
  /** Re-run the drive init path (same code path as first load). */
  onRetryConfig: () => void;
}

export function FolderSelectionGate({
  isLoggedIn,
  isHydrated,
  appRootFolder,
  showFolderSelection,
  token,
  rootFolders,
  onCommitRoots,
  onDone,
  onCancel,
  configError,
  onRetryConfig,
}: FolderSelectionGateProps) {
  const { t } = useTranslation();
  // P2-04-8: appRootFolder=null doubles as the store's initial placeholder
  // while useDriveInit still verifies the remote config — do not read it as
  // "no root configured" until that run settles (otherwise a re-login flashes
  // the full-screen picker for the whole network window). An explicit user
  // request (Settings -> Change folder) still wins over the guard.
  if (isLoggedIn && !isHydrated && !showFolderSelection) return null;
  // The remote config exists but could not be read and there is no local copy:
  // "couldn't load" is NOT "you are new", so the first-run picker must stay
  // out of the DOM and a retry surface takes its place.
  if (
    isLoggedIn &&
    configError === "unavailable" &&
    !appRootFolder &&
    !showFolderSelection
  ) {
    return (
      <div data-testid="config-unavailable-gate">
        <RootFolderSetupShell
          footer={
            <button
              type="button"
              className={PRIMARY_BUTTON_CLASS}
              onClick={onRetryConfig}
            >
              {t("folder_selection.config_unavailable_retry")}
            </button>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t("folder_selection.config_unavailable_body")}
          </p>
        </RootFolderSetupShell>
      </div>
    );
  }
  if (!(isLoggedIn && (!appRootFolder || showFolderSelection))) return null;
  return (
    <RootFolderSetupFlow
      token={token ?? ""}
      currentRoots={rootFolders}
      onCommit={onCommitRoots}
      onDone={onDone}
      onCancel={appRootFolder ? onCancel : undefined}
    />
  );
}
