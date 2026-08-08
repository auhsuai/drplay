import { FolderSelectionScreen } from "./FolderSelection/FolderSelectionScreen";
import { ROOT_FOLDER_ID } from "../utils/driveConstants";

interface FolderSelectionGateProps {
  isLoggedIn: boolean;
  appRootFolder: string | null;
  showFolderSelection: boolean;
  token: string | null;
  onSelectFolder: (folderId: string) => void;
  onCancel: (() => void) | undefined;
}

export function FolderSelectionGate({
  isLoggedIn,
  appRootFolder,
  showFolderSelection,
  token,
  onSelectFolder,
  onCancel,
}: FolderSelectionGateProps) {
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
