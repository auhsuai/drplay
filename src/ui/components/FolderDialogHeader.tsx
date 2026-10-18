import { HardDrive } from "lucide-react";

export interface FolderDialogHeaderProps {
  titleId: string;
  title: string;
  subtitle: string;
  onCancel?: (() => void) | undefined;
}

export function FolderDialogHeader({
  titleId,
  title,
  subtitle,
  onCancel,
}: FolderDialogHeaderProps) {
  return (
    <div className="px-6 py-5 flex items-center justify-between shrink-0">
      <div>
        <h1
          id={titleId}
          className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3"
        >
          <HardDrive className="text-brand-text w-6 h-6" />
          {title}
        </h1>
        <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
      </div>
      {onCancel && (
        <button
          onClick={onCancel}
          className="text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M6 18L18 6M6 6l12 12"
            ></path>
          </svg>
        </button>
      )}
    </div>
  );
}
