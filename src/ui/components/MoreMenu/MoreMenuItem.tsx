import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface MoreMenuItemProps {
  icon: LucideIcon;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string | undefined;
  className: string;
  iconClassName?: string;
  truncateLabel?: boolean;
  /**
   * The menuModel id this row renders. Optional, so every existing caller is
   * untouched; the video menu sets it so keyboard focus can be moved to a
   * specific entry (submenu open/close) without a second item renderer.
   */
  menuId?: string | undefined;
  /** Toggle state, exposed as aria-checked (the native menu's checked flag). */
  checked?: boolean | undefined;
  /**
   * Nesting level of this row inside the menu tree (0 = top level). Optional;
   * the video menu uses it to rebuild the open-submenu chain from a focused row.
   */
  depth?: number | undefined;
  /** Trailing slot (the video menu's submenu chevron). */
  trailing?: ReactNode;
  /**
   * APG submenu state. `undefined` (the default) renders a plain menuitem;
   * a boolean marks the row as a submenu parent.
   */
  expanded?: boolean | undefined;
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
  menuId,
  checked,
  depth,
  trailing,
  expanded,
}: MoreMenuItemProps) {
  // APG: a checkable row is a menuitemcheckbox (aria-checked is not a valid
  // attribute on a plain menuitem). Rows without a `checked` value keep the
  // plain role, so every existing caller is unaffected.
  const checkable = checked !== undefined;
  return (
    <button
      type="button"
      role={checkable ? "menuitemcheckbox" : "menuitem"}
      data-menu-id={menuId}
      data-depth={depth}
      aria-checked={checkable ? checked : undefined}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      onClick={(e) => {
        // APG: disabled menu items stay focusable and announced via
        // aria-disabled, but must not activate.
        if (disabled) return;
        onClick(e);
      }}
      className={`${className}${disabled ? " opacity-50 cursor-not-allowed" : ""}`}
      aria-disabled={disabled || undefined}
      title={title}
    >
      <Icon className={iconClassName} />
      {truncateLabel ? <span className="truncate">{label}</span> : label}
      {trailing}
    </button>
  );
}
