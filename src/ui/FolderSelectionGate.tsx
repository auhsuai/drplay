import { RootFolderSetupFlow } from "./FolderSelection/RootFolderSetupFlow";
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
}: FolderSelectionGateProps) {
  // P2-04-8: appRootFolder=null doubles as the store's initial placeholder
  // while useDriveInit still verifies the remote config — do not read it as
  // "no root configured" until that run settles (otherwise a re-login flashes
  // the full-screen picker for the whole network window). An explicit user
  // request (Settings -> Change folder) still wins over the guard.
  if (isLoggedIn && !isHydrated && !showFolderSelection) return null;
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
