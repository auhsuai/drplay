import { LoaderCircle, Ellipsis } from "lucide-react";

interface MoreMenuTriggerProps {
  isOpen: boolean;
  isMenuOpen: boolean | undefined;
  isDownloadingFile: boolean;
  onToggle: () => void;
  onMeasure: (rect: DOMRect) => void;
  /** Compact mobile sizing (Task 13): h-8 w-8 target with a 16px icon. */
  compact?: boolean | undefined;
}

export function MoreMenuTrigger({
  isOpen,
  isMenuOpen,
  isDownloadingFile,
  onToggle,
  onMeasure,
  compact = false,
}: MoreMenuTriggerProps) {
  return (
    <button
      onClick={(e) => {
        if (!isDownloadingFile) {
          e.stopPropagation();
          if (!isOpen) {
            onMeasure(e.currentTarget.getBoundingClientRect());
          }
          onToggle();
        }
      }}
      disabled={isDownloadingFile}
      aria-haspopup="menu"
      aria-expanded={isMenuOpen}
      className={`relative rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-brand-primary/40 ${compact ? "h-8 w-8 flex items-center justify-center" : "p-2"} ${isDownloadingFile ? "cursor-default opacity-50" : "text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a]"}`}
    >
      {isDownloadingFile ? (
        <LoaderCircle
          className={`${compact ? "w-4 h-4" : "w-5 h-5"} animate-spin text-brand-primary`}
        />
      ) : (
        <Ellipsis className={compact ? "w-4 h-4" : "w-5 h-5"} />
      )}
    </button>
  );
}
