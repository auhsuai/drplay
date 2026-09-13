import { SquareCheckBig } from "lucide-react";
import { useTranslation } from "react-i18next";

const ACTIVE_CLASS = "text-brand-primary hover:bg-brand-primary/10";
const IDLE_CLASS =
  "text-gray-500 hover:text-brand-primary hover:bg-brand-primary/10";

export interface QueueControlsProps {
  selectionMode: boolean;
  onToggleSelectionMode: () => void;
}

/** Multi-select toggle (play-mode switch lives on the PlayerBar cycle). */
export function QueueControls({
  selectionMode,
  onToggleSelectionMode,
}: QueueControlsProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onToggleSelectionMode}
      aria-pressed={selectionMode}
      aria-label={t("queue.select_multiple")}
      title={t("queue.select_multiple")}
      className={`p-2 rounded-full transition-all active:scale-[0.92] shrink-0 ${
        selectionMode ? ACTIVE_CLASS : IDLE_CLASS
      }`}
    >
      <SquareCheckBig className="w-5 h-5" />
    </button>
  );
}
