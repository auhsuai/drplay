import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FolderDialogHeader } from "../../components/FolderDialogHeader";

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
        {/* Header */}
        <FolderDialogHeader
          titleId={TITLE_ID}
          title={t("folder_selection.select_root")}
          subtitle={t("folder_selection.select_music_folder")}
          onCancel={onCancel}
        />

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
