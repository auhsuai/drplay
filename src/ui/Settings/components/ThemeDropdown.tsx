import { useState, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThemeType } from "../../../hooks/useTheme";
import { useClickOutside } from "../../../hooks/useClickOutside";

export function ThemeDropdown({
  currentTheme,
  onChange,
}: {
  currentTheme: ThemeType;
  onChange: (theme: ThemeType) => void;
}) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useClickOutside(
    menuRef,
    () => {
      setIsOpen(false);
    },
    isOpen,
  );

  const themes: { code: ThemeType; label: string }[] = [
    { code: "light", label: t("settings.light_mode") },
    { code: "dark", label: t("settings.dark_mode") },
    { code: "system", label: t("settings.system_mode") },
  ];

  const currentOption = themes.find((tm) => tm.code === currentTheme) ??
    themes[2] ?? { code: "system", label: "System Default" };

  const handleSelect = (code: ThemeType) => {
    onChange(code);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => {
          setIsOpen(!isOpen);
        }}
        className="flex items-center gap-3 bg-gray-100 dark:bg-[#1f2024] text-gray-900 dark:text-white text-sm font-medium rounded-xl px-4 py-2.5 hover:bg-gray-200 dark:hover:bg-[#2a2b2f] transition-all duration-200 w-44 justify-between focus:outline-none focus:ring-2 focus:ring-brand-primary/40 group"
      >
        <span className="truncate group-hover:text-brand-primary transition-colors">
          {currentOption.label}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-gray-500 group-hover:text-brand-primary transition-transform duration-300 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-44 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-xl p-1 z-50 flex flex-col transform origin-top-right transition-all animate-in fade-in zoom-in-95 duration-200">
          {themes.map((option) => (
            <button
              key={option.code}
              onClick={() => {
                handleSelect(option.code);
              }}
              className="w-full text-left px-3 py-2 text-sm flex items-center justify-between rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors group"
            >
              <span
                className={`truncate ${currentOption.code === option.code ? "text-brand-primary font-semibold" : "text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors"}`}
              >
                {option.label}
              </span>
              {currentOption.code === option.code && (
                <Check className="w-4 h-4 text-brand-primary" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
