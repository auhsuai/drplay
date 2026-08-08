import { RateLimitModal } from "./components/RateLimitModal";

interface RateLimitGateProps {
  isOpen: boolean;
  onClose: () => void;
  onOk: () => void;
}

export function RateLimitGate({ isOpen, onClose, onOk }: RateLimitGateProps) {
  return <RateLimitModal isOpen={isOpen} onClose={onClose} onOk={onOk} />;
}
