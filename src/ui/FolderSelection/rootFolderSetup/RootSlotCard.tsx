import { Folder } from "lucide-react";

export interface RootSlotCardProps {
  label: string;
  folderName: string | null;
  disabled: boolean;
  onClick: () => void;
}

export function RootSlotCard({
  label,
  folderName,
  disabled,
  onClick,
}: RootSlotCardProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
      className={`p-4 rounded-xl bg-[#F8F9FA] dark:bg-[#202124] flex items-center gap-4 text-left transition-all duration-300 ${
        disabled
          ? "opacity-50 cursor-not-allowed"
          : "hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md hover:-translate-y-1 cursor-pointer group"
      }`}
    >
      <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-amber-100 dark:bg-amber-900/30 text-amber-500">
        <Folder className="w-6 h-6" fill="currentColor" />
      </div>
      <div className="overflow-hidden flex-1">
        <p className="text-xs uppercase tracking-wider text-gray-500">
          {label}
        </p>
        <p className="font-semibold text-gray-800 dark:text-gray-200 group-hover:text-brand-text transition-colors truncate">
          {folderName ?? "—"}
        </p>
      </div>
    </button>
  );
}
