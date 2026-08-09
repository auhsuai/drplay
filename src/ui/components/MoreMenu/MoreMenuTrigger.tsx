import { LoaderCircle, MoreHorizontal } from "lucide-react";

interface MoreMenuTriggerProps {
  isOpen: boolean;
  isMenuOpen: boolean | undefined;
  isDownloadingFile: boolean;
  onToggle: () => void;
  onMeasure: (rect: DOMRect) => void;
}

export function MoreMenuTrigger({
  isOpen,
  isMenuOpen,
  isDownloadingFile,
  onToggle,
  onMeasure,
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
      className={`relative p-2 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-brand-primary/40 ${isDownloadingFile ? "cursor-default opacity-50" : "text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a]"}`}
    >
      {isDownloadingFile ? (
        <LoaderCircle className="w-5 h-5 animate-spin text-brand-primary" />
      ) : (
        <MoreHorizontal className="w-5 h-5" />
      )}
    </button>
  );
}
