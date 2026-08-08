import type { ReactNode } from "react";

export function NavItem({
  icon,
  label,
  active,
  onClick,
  isSidebarOpen,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  isSidebarOpen: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={!isSidebarOpen ? label : undefined}
      className={`group flex items-center px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 active:scale-[0.98] font-medium ${
        active
          ? "bg-[#4285F4]/10 text-[#4285F4] shadow-sm"
          : "text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-[#2a2b2f] hover:text-gray-900 dark:hover:text-white"
      }`}
    >
      <div
        className={`w-6 h-6 flex items-center justify-center shrink-0 transition-colors ${active ? "text-[#4285F4]" : "opacity-70 group-hover:text-[#4285F4] group-hover:opacity-100"}`}
      >
        {icon}
      </div>
      <div
        className={`overflow-hidden transition-all duration-300 whitespace-nowrap ${isSidebarOpen ? "max-w-[150px] opacity-100 ml-3 flex-1" : "max-w-0 opacity-0 ml-0"}`}
      >
        <span className="text-sm block truncate group-hover:text-[#4285F4]">
          {label}
        </span>
      </div>
    </div>
  );
}
