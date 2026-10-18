import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";

const TITLE_ID = "root-folder-setup-title";

export interface RootFolderSetupShellProps {
  footer: ReactNode;
  children: ReactNode;
  onCancel?: (() => void) | undefined;
  isInert?: boolean;
}

export function RootFolderSetupShell({
  footer,
  children,
  onCancel,
  isInert = false,
}: RootFolderSetupShellProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  // APG dialog-modal: focus moves into the dialog when the shell mounts (the
  // mode/editor step owns the flow; the confirm step is a separate dialog).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-hidden={isInert}
        inert={isInert}
        tabIndex={-1}
        className="bg-white dark:bg-[#121212] w-full max-w-3xl h-[75vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header (same markup as FolderSelectionScreen) */}
        <div className="px-6 py-5 flex items-center justify-between shrink-0">
          <div>
            <h1
              id={TITLE_ID}
              className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-3"
            >
              <HardDrive className="text-brand-text w-6 h-6" />
              {t("folder_selection.select_root")}
            </h1>
            <p className="text-xs text-gray-500 mt-1">
              {t("folder_selection.select_music_folder")}
            </p>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                ></path>
              </svg>
            </button>
          )}
        </div>

        {/* Scrollable body: five slot cards must not push the footer off */}
        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-5">
          {children}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-between gap-3 shrink-0">
          {footer}
        </div>
      </div>
    </div>
  );
}
