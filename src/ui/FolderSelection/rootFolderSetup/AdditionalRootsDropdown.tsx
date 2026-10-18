import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useClickOutside } from "../../../hooks/useClickOutside";

export interface AdditionalRootsDropdownProps {
  label: string;
  value: number;
  options: readonly number[];
  onChange: (value: number) => void;
  onOpenChange?: (isOpen: boolean) => void;
}

export function AdditionalRootsDropdown({
  label,
  value,
  options,
  onChange,
  onOpenChange,
}: AdditionalRootsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useClickOutside(
    menuRef,
    () => {
      setIsOpen(false);
    },
    isOpen,
  );

  // Let the surrounding flow stand down its Escape handler while the menu is
  // open, so one press closes only the menu (the menu owns the key).
  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // Escape closes the menu and returns focus to the trigger (disclosure
  // pattern). Capture + stopPropagation: the surrounding flow also listens
  // for Escape and must not cancel the whole setup while the menu owns the
  // key.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </span>
      <div className="relative w-44" ref={menuRef}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={isOpen}
          aria-label={label}
          onClick={() => {
            setIsOpen(!isOpen);
          }}
          className="flex items-center gap-3 bg-gray-100 dark:bg-[#1f2024] text-gray-900 dark:text-white text-sm font-medium rounded-xl px-4 py-2.5 hover:bg-gray-200 dark:hover:bg-[#2a2b2f] transition-all duration-200 w-full justify-between focus:outline-none focus:ring-2 focus:ring-brand-primary/40 group"
        >
          <span className="truncate group-hover:text-brand-text transition-colors">
            {value}
          </span>
          <ChevronDown
            className={`w-4 h-4 text-gray-500 group-hover:text-brand-text transition-transform duration-300 ${isOpen ? "rotate-180" : ""}`}
          />
        </button>

        {isOpen && (
          <div className="absolute right-0 top-full mt-2 w-44 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-xl p-1 z-50 flex flex-col transform origin-top-right transition-all animate-in fade-in zoom-in-95 duration-200">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm flex items-center justify-between rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors group"
              >
                <span
                  className={`truncate ${value === option ? "text-brand-text font-semibold" : "text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors"}`}
                >
                  {option}
                </span>
                {value === option && (
                  <Check className="w-4 h-4 text-brand-text" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
