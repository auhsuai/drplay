import type { ReactNode } from "react";

export function NavItem({
  icon,
  label,
  labelIcon,
  active,
  onClick,
  isSidebarOpen,
  action,
  onContextMenu,
}: {
  icon: ReactNode;
  label: string;
  // Optional inline marker rendered before the label text (e.g. the pin on a
  // pinned playlist). Callers that omit it keep the exact previous markup.
  labelIcon?: ReactNode;
  active?: boolean;
  onClick: () => void;
  isSidebarOpen: boolean;
  // Trailing row action (e.g. the playlist ⋯ menu). Rendered as-is; callers
  // omit it entirely when the sidebar is collapsed so no invisible hit area
  // or layout shift survives the collapse.
  action?: ReactNode;
  onContextMenu?: ((e: React.MouseEvent) => void) | undefined;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // Nested controls (the row action's ⋯ trigger) own their keys.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClick();
      }}
      title={!isSidebarOpen ? label : undefined}
      className={`group flex items-center px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 active:scale-[0.98] font-medium ${
        active
          ? "bg-brand-primary/10 text-brand-text shadow-sm"
          : "text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-[#2a2b2f] hover:text-gray-900 dark:hover:text-white"
      }`}
    >
      <div
        className={`w-6 h-6 flex items-center justify-center shrink-0 transition-colors ${active ? "text-brand-text" : "opacity-70 group-hover:text-brand-text group-hover:opacity-100"}`}
      >
        {icon}
      </div>
      <div
        className={`overflow-hidden transition-all duration-300 whitespace-nowrap ${isSidebarOpen ? "max-w-[150px] opacity-100 ml-3 flex-1" : "max-w-0 opacity-0 ml-0"}`}
      >
        <span className="text-sm block truncate group-hover:text-brand-text">
          {labelIcon ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {labelIcon}
              <span className="truncate">{label}</span>
            </span>
          ) : (
            label
          )}
        </span>
      </div>
      {action}
    </div>
  );
}
