import { FolderSelectionScreen } from "./FolderSelection/FolderSelectionScreen";
import { ROOT_FOLDER_ID } from "../utils/driveConstants";

interface FolderSelectionGateProps {
  isLoggedIn: boolean;
  isHydrated: boolean;
  appRootFolder: string | null;
  showFolderSelection: boolean;
  token: string | null;
  onSelectFolder: (folderId: string) => void;
  onCancel: (() => void) | undefined;
}

export function FolderSelectionGate({
  isLoggedIn,
  isHydrated,
  appRootFolder,
  showFolderSelection,
  token,
  onSelectFolder,
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
    <FolderSelectionScreen
      token={token ?? ""}
      onSelectFolder={onSelectFolder}
      onCancel={onCancel}
      initialFolderId={ROOT_FOLDER_ID}
      initialFolderHistory={[]}
      allowEscapeRoot={true}
    />
  );
}
