import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useClickOutside } from "../../hooks/useClickOutside";

const DEFAULT_TRIGGER_CLASS =
  "flex items-center gap-3 bg-gray-100 dark:bg-[#1f2024] text-gray-900 dark:text-white text-sm font-medium rounded-xl px-4 py-2.5 hover:bg-gray-200 dark:hover:bg-[#2a2b2f] transition-all duration-200 w-44 justify-between focus:outline-none focus:ring-2 focus:ring-brand-primary/40 group";

const DEFAULT_MENU_CLASS =
  "absolute right-0 top-full mt-2 w-44 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-xl p-1 z-50 flex flex-col transform origin-top-right transition-all animate-in fade-in zoom-in-95 duration-200";

export interface OptionDropdownOption {
  value: string;
  label: string;
}

export interface OptionDropdownProps {
  ariaLabel: string;
  value: string;
  options: readonly OptionDropdownOption[];
  onChange: (value: string) => void;
  onOpenChange?: ((isOpen: boolean) => void) | undefined;
  rootClassName?: string;
  triggerClassName?: string;
  menuClassName?: string;
}

export function OptionDropdown({
  ariaLabel,
  value,
  options,
  onChange,
  onOpenChange,
  rootClassName = "relative",
  triggerClassName = DEFAULT_TRIGGER_CLASS,
  menuClassName = DEFAULT_MENU_CLASS,
}: OptionDropdownProps) {
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

  const currentOption = options.find((option) => option.value === value);

  const handleSelect = (nextValue: string) => {
    onChange(nextValue);
    setIsOpen(false);
  };

  return (
    <div className={rootClassName} ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={() => {
          setIsOpen(!isOpen);
        }}
        className={triggerClassName}
      >
        <span className="truncate group-hover:text-brand-text transition-colors">
          {currentOption?.label ?? value}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-gray-500 group-hover:text-brand-text transition-transform duration-300 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div className={menuClassName}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                handleSelect(option.value);
              }}
              className="w-full text-left px-3 py-2 text-sm flex items-center justify-between rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors group"
            >
              <span
                className={`truncate ${value === option.value ? "text-brand-text font-semibold" : "text-gray-700 dark:text-gray-200 group-hover:text-gray-900 dark:group-hover:text-white transition-colors"}`}
              >
                {option.label}
              </span>
              {value === option.value && (
                <Check className="w-4 h-4 text-brand-text" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
