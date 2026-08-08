import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RefObject } from "react";

export function FolderSearchInput({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative shrink-0 w-56">
      <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        placeholder={t("search_placeholder")}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="w-full pl-9 pr-3 py-2 text-sm bg-gray-100 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-white dark:focus:bg-[#1c1d21] text-gray-900 dark:text-gray-100 rounded-xl border border-transparent focus:border-[#4285F4]/50 outline-none transition-all placeholder:text-gray-500"
      />
    </div>
  );
}
