import { Minus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

// Same trigger language as MoreMenuTrigger (MoreMenu components are shared and
// deliberately untouched): pill hit area, muted glyph, brand focus ring.
const TRIGGER_CLASS =
  "relative p-2 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-brand-primary/40";
const MUTED_TRIGGER_CLASS = `${TRIGGER_CLASS} text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a]`;
const DELETE_TRIGGER_CLASS = `${TRIGGER_CLASS} text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20`;

export interface RootRowActionsProps {
  /** Number of roots in the draft: 2+ removes, exactly 1 changes, 0 nothing. */
  rootCount: number;
  onChangeRoot: () => void;
  onRequestRemove: () => void;
}

export function RootRowActions({
  rootCount,
  onChangeRoot,
  onRequestRemove,
}: RootRowActionsProps) {
  const { t } = useTranslation();

  if (rootCount >= 2) {
    return (
      <button
        type="button"
        aria-label={t("folder_selection.remove_root")}
        onClick={onRequestRemove}
        className={DELETE_TRIGGER_CLASS}
      >
        <Minus className="w-5 h-5" />
      </button>
    );
  }

  if (rootCount === 1) {
    return (
      <button
        type="button"
        aria-label={t("folder_selection.change_root")}
        onClick={onChangeRoot}
        className={MUTED_TRIGGER_CLASS}
      >
        <RefreshCw className="w-5 h-5" />
      </button>
    );
  }

  return null;
}
