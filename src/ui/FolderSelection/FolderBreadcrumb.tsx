import React from "react";
import { useHorizontalScroll } from "../../hooks/useHorizontalScroll";

export function FolderBreadcrumb({
  folderHistory,
  currentFolderName,
  onBreadcrumbClick,
}: {
  folderHistory: { id: string; name: string }[];
  currentFolderName: string;
  onBreadcrumbClick: (index: number) => void;
}) {
  const scrollRef = useHorizontalScroll();

  return (
    <div
      ref={scrollRef}
      className="flex items-center text-sm font-medium overflow-x-auto whitespace-nowrap hide-scrollbar flex-1 min-w-0 mr-2"
    >
      {folderHistory.map((item, index) => (
        <React.Fragment key={index}>
          <button
            type="button"
            onClick={() => {
              onBreadcrumbClick(index);
            }}
            className="cursor-pointer text-gray-500 dark:text-gray-400 hover:text-brand-text transition-colors"
          >
            {item.name}
          </button>
          <span className="mx-2 text-gray-400 dark:text-gray-600">/</span>
        </React.Fragment>
      ))}
      <span className="text-gray-900 dark:text-white truncate">
        {currentFolderName}
      </span>
    </div>
  );
}
