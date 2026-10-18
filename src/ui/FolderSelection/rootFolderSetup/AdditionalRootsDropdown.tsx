import { OptionDropdown } from "../../components/OptionDropdown";

const TRIGGER_CLASS =
  "flex items-center gap-3 bg-gray-100 dark:bg-[#1f2024] text-gray-900 dark:text-white text-sm font-medium rounded-xl px-4 py-2.5 hover:bg-gray-200 dark:hover:bg-[#2a2b2f] transition-all duration-200 w-full justify-between focus:outline-none focus:ring-2 focus:ring-brand-primary/40 group";

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
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </span>
      <OptionDropdown
        ariaLabel={label}
        value={String(value)}
        options={options.map((option) => ({
          value: String(option),
          label: String(option),
        }))}
        onChange={(next) => {
          const selected = options.find((option) => String(option) === next);
          if (selected !== undefined) onChange(selected);
        }}
        onOpenChange={onOpenChange}
        rootClassName="relative w-44"
        triggerClassName={TRIGGER_CLASS}
      />
    </div>
  );
}
