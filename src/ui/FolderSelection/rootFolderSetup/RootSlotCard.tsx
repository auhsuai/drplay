import type { ReactNode } from "react";
import { Folder } from "lucide-react";

export interface RootSlotCardProps {
  label: string;
  folderName: string | null;
  emptyLabel: string;
  disabled?: boolean;
  isEditable?: boolean;
  onClick: () => void;
  trailingAction?: ReactNode;
}

export function RootSlotCard({
  label,
  folderName,
  emptyLabel,
  disabled = false,
  isEditable = false,
  onClick,
  trailingAction,
}: RootSlotCardProps) {
  // The outer container owns the background and the hover lift so the trailing
  // action travels with the row as one unit. View mode is inert: no lift, no
  // cursor, no click target.
  const rowClass = `flex items-center rounded-xl bg-[#F8F9FA] dark:bg-[#202124] transition-all duration-300 ${
    disabled ? "opacity-50" : ""
  } ${
    isEditable && !disabled
      ? "hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md hover:-translate-y-1 group"
      : ""
  }`;

  const content = (
    <>
      <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-amber-100 dark:bg-amber-900/30 text-amber-500">
        <Folder className="w-6 h-6" fill="currentColor" />
      </div>
      <div className="overflow-hidden flex-1">
        <p className="text-xs uppercase tracking-wider text-gray-500">
          {label}
        </p>
        <p className="font-semibold text-gray-800 dark:text-gray-200 group-hover:text-brand-text transition-colors truncate">
          {folderName ?? emptyLabel}
        </p>
      </div>
    </>
  );

  return (
    <div className={rowClass} data-testid="root-slot-row">
      {isEditable ? (
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          onClick={onClick}
          className={`flex flex-1 min-w-0 items-center gap-4 p-4 text-left focus:outline-none focus:ring-2 focus:ring-brand-primary/40 ${
            disabled ? "cursor-not-allowed" : "cursor-pointer"
          }`}
        >
          {content}
        </button>
      ) : (
        <div className="flex flex-1 min-w-0 items-center gap-4 p-4">
          {content}
        </div>
      )}
      {trailingAction !== undefined && (
        <div className="flex items-center shrink-0 pr-3">{trailingAction}</div>
      )}
    </div>
  );
}
