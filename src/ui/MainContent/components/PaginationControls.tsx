import React from 'react';
import { useTranslation } from 'react-i18next';
import { ReactVirtualizer } from '@tanstack/react-virtual';

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  setCurrentPage: (page: number | ((p: number) => number)) => void;
  rowVirtualizer: ReactVirtualizer<HTMLElement, Element>;
}

export function PaginationControls({
  currentPage,
  totalPages,
  setCurrentPage,
  rowVirtualizer
}: PaginationControlsProps) {
  const { t } = useTranslation();
  const [isEditingPage, setIsEditingPage] = React.useState(false);
  const [pageInputValue, setPageInputValue] = React.useState("");
  const pageInputRef = React.useRef<HTMLInputElement>(null);

  if (totalPages <= 1) return null;

  return (
    <div className={`sticky bottom-0 w-full flex justify-center items-end pb-0 pt-6 pointer-events-none ${isEditingPage ? 'z-50' : 'z-20'}`}>
      <div className="flex items-center justify-center gap-3 sm:gap-6 pointer-events-auto pb-1 w-full max-w-[400px]">
        <div className="flex justify-end">
          <button 
            disabled={currentPage === 1}
            onClick={() => {
              setCurrentPage(p => p - 1);
              setTimeout(() => rowVirtualizer.scrollToIndex(0, { align: 'start' }), 0);
            }}
            className="whitespace-nowrap px-3 sm:px-4 py-2 text-sm font-medium rounded-xl bg-gray-100 dark:bg-[#2a2b2f] text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-[#3a3b3f] disabled:opacity-40 disabled:hover:bg-gray-100 dark:disabled:hover:bg-[#2a2b2f] transition-colors"
          >
            {t('playlist.prev', 'Previous')}
          </button>
        </div>
        
        <div className="flex justify-center relative">
          {isEditingPage && (
            <div 
              className="fixed inset-0 cursor-default bg-transparent"
              style={{ zIndex: -1 }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsEditingPage(false);
              }}
            />
          )}
          
          <div 
            className={`flex items-center text-sm font-medium text-gray-900 dark:text-white tracking-wider text-center drop-shadow-md transition-colors ${!isEditingPage ? 'cursor-pointer hover:text-[#4285F4]' : ''}`}
            onClick={() => {
              if (!isEditingPage) {
                setIsEditingPage(true);
                setPageInputValue(currentPage.toString());
                setTimeout(() => pageInputRef.current?.focus(), 0);
              }
            }}
          >
            <input
              ref={pageInputRef}
              type="text"
              readOnly={!isEditingPage}
              value={isEditingPage ? pageInputValue : currentPage}
              onChange={(e) => isEditingPage && setPageInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const newPage = parseInt(pageInputValue.trim(), 10);
                  if (!isNaN(newPage) && newPage >= 1 && newPage <= totalPages) {
                    setCurrentPage(newPage);
                    setTimeout(() => rowVirtualizer.scrollToIndex(0, { align: 'start' }), 0);
                  }
                  setIsEditingPage(false);
                }
                if (e.key === 'Escape') {
                  setIsEditingPage(false);
                }
              }}
              onBlur={() => {
                if (isEditingPage) {
                  const newPage = parseInt(pageInputValue.trim(), 10);
                  if (!isNaN(newPage) && newPage >= 1 && newPage <= totalPages) {
                    setCurrentPage(newPage);
                    setTimeout(() => rowVirtualizer.scrollToIndex(0, { align: 'start' }), 0);
                  }
                  setIsEditingPage(false);
                }
              }}
              className={`text-right bg-transparent outline-none p-0 m-0 text-inherit font-inherit ${!isEditingPage ? 'cursor-pointer pointer-events-none' : ''}`}
              style={{ 
                width: `${Math.max(1, (isEditingPage ? pageInputValue : currentPage.toString()).length)}ch`,
                caretColor: isEditingPage ? 'inherit' : 'transparent' 
              }}
            />
            <span className="whitespace-pre"> / {totalPages}</span>
          </div>
        </div>

        <div className="flex justify-start">
          <button 
            disabled={currentPage === totalPages}
            onClick={() => {
              setCurrentPage(p => p + 1);
              setTimeout(() => rowVirtualizer.scrollToIndex(0, { align: 'start' }), 0);
            }}
            className="whitespace-nowrap px-3 sm:px-4 py-2 text-sm font-medium rounded-xl bg-gray-100 dark:bg-[#2a2b2f] text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-[#3a3b3f] disabled:opacity-40 disabled:hover:bg-gray-100 dark:disabled:hover:bg-[#2a2b2f] transition-colors"
          >
            {t('playlist.next', 'Next')}
          </button>
        </div>
      </div>
    </div>
  );
}
