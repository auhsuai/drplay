import React from "react";

export function FolderBreadcrumb({
  folderHistory,
  currentFolderName,
  onBreadcrumbClick,
}: {
  folderHistory: { id: string; name: string }[];
  currentFolderName: string;
  onBreadcrumbClick: (index: number) => void;
}) {
  return (
    <div className="flex items-center text-sm font-medium overflow-x-auto whitespace-nowrap hide-scrollbar flex-1 min-w-0 mr-2">
      {folderHistory.map((item, index) => (
        <React.Fragment key={index}>
          <span
            role="button"
            tabIndex={0}
            onClick={() => {
              onBreadcrumbClick(index);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onBreadcrumbClick(index);
              }
            }}
            className="cursor-pointer text-gray-500 dark:text-gray-400 hover:text-brand-primary transition-colors"
          >
            {item.name}
          </span>
          <span className="mx-2 text-gray-400 dark:text-gray-600">/</span>
        </React.Fragment>
      ))}
      <span className="text-gray-900 dark:text-white truncate">
        {currentFolderName}
      </span>
    </div>
  );
}
