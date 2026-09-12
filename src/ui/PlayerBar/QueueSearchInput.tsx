import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface QueueSearchInputProps {
  value: string;
  onChange: (value: string) => void;
}

/** Search box filtering the queue by title/artist (accent-insensitive). */
export function QueueSearchInput({ value, onChange }: QueueSearchInputProps) {
  const { t } = useTranslation();
  const placeholder = t("queue.search_placeholder");

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full pl-9 pr-3 py-1.5 text-sm font-medium bg-gray-100 dark:bg-[#1a1b1e] text-gray-900 dark:text-gray-100 rounded-lg outline-none focus:ring-2 focus:ring-brand-primary/50 border border-transparent focus:border-transparent transition-all placeholder:text-gray-400"
      />
    </div>
  );
}
