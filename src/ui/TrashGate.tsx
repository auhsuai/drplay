import { TrashScreen } from "./Settings/TrashScreen";

interface TrashGateProps {
  showTrashScreen: boolean;
  token: string | null;
  onClose: () => void;
}

export function TrashGate({ showTrashScreen, token, onClose }: TrashGateProps) {
  if (!showTrashScreen || !token) return null;
  return <TrashScreen token={token} onClose={onClose} />;
}
