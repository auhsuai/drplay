import { useEffect } from "react";
import { TrashScreen } from "./Settings/TrashScreen";

interface TrashGateProps {
  showTrashScreen: boolean;
  token: string | null;
  onClose: () => void;
}

export function TrashGate({ showTrashScreen, token, onClose }: TrashGateProps) {
  // Logout (token → null) must clear the persisted "open" intent: the gate can
  // only render with a token, so a stale `showTrashScreen=true` would pop the
  // Trash modal back up on the next login. Idempotent — safe to re-run.
  useEffect(() => {
    if (showTrashScreen && !token) onClose();
  }, [showTrashScreen, token, onClose]);

  if (!showTrashScreen || !token) return null;
  return <TrashScreen token={token} onClose={onClose} />;
}
