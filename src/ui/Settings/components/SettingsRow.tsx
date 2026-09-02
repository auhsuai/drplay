import type { ReactNode } from "react";
import { IS_MOBILE } from "../../../utils/platform";

const SECTION_HEADING =
  "text-sm font-bold text-brand-primary uppercase tracking-wider mb-2";

export function SettingsSectionHeading({ title }: { title: string }) {
  return <h2 className={SECTION_HEADING}>{title}</h2>;
}

interface SettingsRowProps {
  icon: ReactNode;
  title: ReactNode;
  className?: string;
  leftClassName?: string;
  textClassName?: string;
  titleTruncate?: boolean;
  titleAttr?: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}

// Shared row shell for every settings row: icon tile + title (+ optional
// subtitle) on the left, the row's control passed as children on the right.
export function SettingsRow({
  icon,
  title,
  className,
  leftClassName,
  textClassName,
  titleTruncate,
  titleAttr,
  subtitle,
  children,
}: SettingsRowProps) {
  // Task 8 + Task 9: setting rows compact two notches on mobile (16px ->
  // 14px -> 13px); desktop keeps text-base — the string is byte-identical
  // to the pre-task markup. Read per-render: IS_MOBILE is a getter-backed
  // mock target in tests, never freeze it at module load.
  const titleClassName = `${IS_MOBILE ? "text-[13px]" : "text-base"} font-semibold text-gray-900 dark:text-gray-100${titleTruncate ? " truncate" : ""}`;
  return (
    <div className={className ?? "flex items-center justify-between py-4 pb-6"}>
      <div className={leftClassName ?? "flex items-center gap-4"}>
        <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className={textClassName ? textClassName : undefined}>
          <p title={titleAttr} className={titleClassName}>
            {title}
          </p>
          {subtitle}
        </div>
      </div>
      {children}
    </div>
  );
}
