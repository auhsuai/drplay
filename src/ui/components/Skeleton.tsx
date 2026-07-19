import React from "react";

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  rounded?: string;
}

const BASE_CLASS =
  "animate-pulse bg-gray-200 dark:bg-[#2a2a2a] transition-colors duration-300";

const toStyle = (width?: string | number, height?: string | number): React.CSSProperties => {
  const style: React.CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  return style;
};

export function Skeleton({
  width,
  height,
  className = "",
  rounded = "rounded",
}: SkeletonProps) {
  return (
    <div
      className={`${BASE_CLASS} ${rounded} ${className}`}
      style={toStyle(width, height)}
      aria-hidden="true"
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
  lineClassName?: string;
  gap?: string;
}

export function SkeletonText({
  lines = 3,
  className = "",
  lineClassName = "",
  gap = "space-y-2",
}: SkeletonTextProps) {
  return (
    <div className={`${gap} ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={12}
          width={i === lines - 1 ? "60%" : "100%"}
          className={lineClassName}
          rounded="rounded"
        />
      ))}
    </div>
  );
}
