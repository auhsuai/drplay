import type { LucideIcon } from "lucide-react";
import { IS_MOBILE } from "../../../utils/platform";
import { menuItemIconClass } from "./constants";

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
  // Default param evaluates at render time, so the live IS_MOBILE binding is
  // read per render (the test mock flips it between cases). An explicit
  // caller-provided iconClassName still wins over both branches.
  iconClassName = menuItemIconClass(IS_MOBILE),
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
