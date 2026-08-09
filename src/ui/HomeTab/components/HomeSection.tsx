import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface HomeSectionProps {
  icon: LucideIcon;
  title: string;
  // Some sections render their header inside a `flex items-center justify-between
  // mb-4` wrapper (no mb-4 on the h3); others put mb-4 directly on the h3.
  justifyBetween?: boolean;
  children: ReactNode;
}

export function HomeSection({
  icon: Icon,
  title,
  justifyBetween = false,
  children,
}: HomeSectionProps) {
  const header = (
    <h3
      className={
        justifyBetween
          ? "text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-2"
          : "text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4 flex items-center gap-2"
      }
    >
      <Icon className="w-4 h-4" />
      {title}
    </h3>
  );

  if (justifyBetween) {
    return (
      <div className="mb-12">
        <div className="flex items-center justify-between mb-4">{header}</div>
        {children}
      </div>
    );
  }

  return (
    <div className="mb-12">
      {header}
      {children}
    </div>
  );
}

export function SectionSkeleton({ children }: { children: ReactNode }) {
  return (
    <div data-testid="home-skeleton-section" className="mb-12">
      {children}
    </div>
  );
}
