import type { LucideIcon } from "lucide-react";

interface MoreMenuItemProps {
  icon: LucideIcon;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string | undefined;
  className: string;
  iconClassName?: string;
  truncateLabel?: boolean;
}

export function MoreMenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  title,
  className,
  iconClassName = "w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity",
  truncateLabel = true,
}: MoreMenuItemProps) {
  return (
    <button
      onClick={onClick}
      className={className}
      disabled={disabled}
      title={title}
    >
      <Icon className={iconClassName} />
      {truncateLabel ? <span className="truncate">{label}</span> : label}
    </button>
  );
}
