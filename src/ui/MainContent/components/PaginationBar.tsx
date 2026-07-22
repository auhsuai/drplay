import React from "react";
import type { ReactVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";

interface PaginationBarProps {
  currentPage: number;
  totalPages: number;
  rowVirtualizer: ReactVirtualizer<HTMLElement, Element>;
  onPageChange: (page: number) => void;
}

export function PaginationBar({
  currentPage,
  totalPages,
  rowVirtualizer,
  onPageChange,
}: PaginationBarProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = React.useState(false);
  const [inputValue, setInputValue] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  if (totalPages <= 1) return null;

  const goTo = (page: number) => {
    if (page < 1 || page > totalPages) return;
    onPageChange(page);
    rowVirtualizer.measure();
    setTimeout(() => rowVirtualizer.scrollToIndex(0, { align: "start" }), 0);
  };

  return (
    <div
      className={`sticky bottom-0 w-full flex justify-center items-end pb-0 pt-6 pointer-events-none ${isEditing ? "z-50" : "z-20"}`}
    >
      <div className="flex items-center justify-center gap-3 sm:gap-6 pointer-events-auto pb-1 w-full max-w-[400px]">
        <div className="flex justify-end">
          <button
            disabled={currentPage === 1}
            onClick={() => goTo(currentPage - 1)}
            className="whitespace-nowrap px-3 sm:px-4 py-2 text-sm font-medium rounded-xl bg-gray-100 dark:bg-[#2a2b2f] text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-[#3a3b3f] disabled:opacity-40 disabled:hover:bg-gray-100 dark:disabled:hover:bg-[#2a2b2f] transition-colors"
          >
            {t("playlist.prev", "Previous")}
          </button>
        </div>

        <div className="flex justify-center relative">
          {isEditing && (
            <div
              className="fixed inset-0 cursor-default bg-transparent"
              style={{ zIndex: -1 }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsEditing(false);
              }}
            />
          )}

          <div
            className={`flex items-center text-sm font-medium text-gray-900 dark:text-white tracking-wider text-center drop-shadow-md transition-colors ${!isEditing ? "cursor-pointer hover:text-[#4285F4]" : ""}`}
            onClick={() => {
              if (!isEditing) {
                setIsEditing(true);
                setInputValue(currentPage.toString());
                setTimeout(() => inputRef.current?.focus(), 0);
              }
            }}
          >
            <input
              ref={inputRef}
              type="text"
              readOnly={!isEditing}
              value={isEditing ? inputValue : currentPage}
              onChange={(e) => isEditing && setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const newPage = parseInt(inputValue.trim(), 10);
                  if (!isNaN(newPage) && newPage >= 1 && newPage <= totalPages) {
                    goTo(newPage);
                  }
                  setIsEditing(false);
                }
                if (e.key === "Escape") {
                  setIsEditing(false);
                }
              }}
              className={`text-right bg-transparent outline-none p-0 m-0 text-inherit font-inherit ${!isEditing ? "cursor-pointer pointer-events-none" : ""}`}
              style={{
                width: `${Math.max(1, (isEditing ? inputValue : currentPage.toString()).length)}ch`,
                caretColor: isEditing ? "inherit" : "transparent",
              }}
            />
            <span className="whitespace-pre"> / {totalPages}</span>
          </div>
        </div>

        <div className="flex justify-start">
          <button
            disabled={currentPage === totalPages}
            onClick={() => goTo(currentPage + 1)}
            className="whitespace-nowrap px-3 sm:px-4 py-2 text-sm font-medium rounded-xl bg-gray-100 dark:bg-[#2a2b2f] text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-[#3a3b3f] disabled:opacity-40 disabled:hover:bg-gray-100 dark:disabled:hover:bg-[#2a2b2f] transition-colors"
          >
            {t("playlist.next", "Next")}
          </button>
        </div>
      </div>
    </div>
  );
}
