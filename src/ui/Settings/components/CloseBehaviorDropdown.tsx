import { useState, useEffect, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

export function CloseBehaviorDropdown({ minimizeToTray, onChange }: { minimizeToTray: boolean, onChange: (minimize: boolean) => void }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const options: { value: boolean, label: string }[] = [
    { value: true, label: t('settings.on') || 'On' },
    { value: false, label: t('settings.off') || 'Off' }
  ];

  const currentOption = options.find(opt => opt.value === minimizeToTray) || options[0];

  const handleSelect = (value: boolean) => {
    onChange(value);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-3 bg-gray-100 dark:bg-[#1f2024] text-gray-900 dark:text-white text-sm font-medium rounded-xl px-4 py-2.5 hover:bg-gray-200 dark:hover:bg-[#2a2b2f] transition-all duration-200 w-32 justify-between focus:outline-none focus:ring-2 focus:ring-[#4285F4]/40 group"
      >
        <span className="truncate group-hover:text-[#4285F4] transition-colors">{currentOption.label}</span>
        <ChevronDown className={`w-4 h-4 text-gray-500 group-hover:text-[#4285F4] transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-32 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-xl p-1 z-50 flex flex-col transform origin-top-right transition-all animate-in fade-in zoom-in-95 duration-200">
          {options.map(option => (
            <button
              key={option.value ? "true" : "false"}
              onClick={() => handleSelect(option.value)}
              className="w-full text-left px-3 py-2 text-sm flex items-center justify-between rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors group"
            >
              <span className={`truncate ${currentOption.value === option.value ? 'text-[#4285F4] font-semibold' : 'text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors'}`}>
                {option.label}
              </span>
              {currentOption.value === option.value && (
                <Check className="w-4 h-4 text-[#4285F4]" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
