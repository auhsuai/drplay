import { HardDrive } from "lucide-react";

interface SidebarHeaderProps {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function SidebarHeader({
  isSidebarOpen,
  onToggleSidebar,
}: SidebarHeaderProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="px-7 py-6 flex items-center cursor-pointer transition-all duration-300"
      onClick={onToggleSidebar}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleSidebar();
        }
      }}
    >
      <h1
        className="text-xl font-bold flex items-center text-brand-primary w-full"
        title="DrPlay"
      >
        <HardDrive className="w-6 h-6 shrink-0" />
        <div
          className={`overflow-hidden transition-all duration-300 whitespace-nowrap flex items-center ${isSidebarOpen ? "max-w-[100px] opacity-100 ml-2" : "max-w-0 opacity-0 ml-0"}`}
        >
          <span className="truncate">DrPlay</span>
        </div>
      </h1>
    </div>
  );
}
