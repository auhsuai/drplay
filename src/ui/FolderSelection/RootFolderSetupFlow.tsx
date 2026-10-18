import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FolderPlus, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { captureError } from "../../utils/errorLog";
import { MAX_ROOT_FOLDERS } from "../../utils/rootFolders";
import type { RootFolder } from "../../utils/rootFolders";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
} from "../components/folderDialogButtonStyles";
import { FolderSelectionScreen } from "./FolderSelectionScreen";
import { RootFolderSetupShell } from "./rootFolderSetup/RootFolderSetupShell";
import { RootRowActions } from "./rootFolderSetup/RootRowActions";
import { RootSlotCard } from "./rootFolderSetup/RootSlotCard";

type Step = "mode" | "slot-picker" | "add-picker" | "confirm";

export interface RootFolderSetupFlowProps {
  token: string;
  currentRoots: RootFolder[];
  onCommit: (roots: RootFolder[]) => Promise<boolean>;
  onDone: () => void;
  onCancel?: (() => void) | undefined;
}

export function RootFolderSetupFlow({
  token,
  currentRoots,
  onCommit,
  onDone,
  onCancel,
}: RootFolderSetupFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("mode");
  const [multiMode, setMultiMode] = useState(currentRoots.length > 1);
  // First run has no row to click yet: start in edit mode so the placeholder
  // row (quick single-root path) and the add tile are usable immediately.
  const [isEditing, setIsEditing] = useState(currentRoots.length === 0);
  const [draftRoots, setDraftRoots] = useState<RootFolder[]>(() => [
    ...currentRoots,
  ]);
  const [activeSlotIndex, setActiveSlotIndex] = useState<number | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitFailed, setCommitFailed] = useState(false);
  const committingRef = useRef(false);

  const hasDuplicate =
    new Set(draftRoots.map((root) => root.id)).size !== draftRoots.length;
  const isInvalid = draftRoots.length === 0 || hasDuplicate;

  const runCommit = useCallback(
    async (roots: RootFolder[]): Promise<boolean> => {
      try {
        return await onCommit(roots);
      } catch (err) {
        void captureError({
          level: "error",
          source: "RootFolderSetupFlow",
          message: `roots-commit-threw:${err instanceof Error ? err.message : String(err)}`,
        });
        return false;
      }
    },
    [onCommit],
  );

  // Window CAPTURE: the setup overlay must swallow Escape before the layers
  // behind it (drawer/menu listeners run in the bubble phase). Stand down while
  // the remove dialog (registered later on the same phase) owns the key.
  useEffect(() => {
    if (step !== "mode") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteIndex !== null) return;
      event.stopPropagation();
      onCancel?.();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [step, onCancel, deleteIndex]);

  const handleRowClick = (index: number) => {
    if (!isEditing) return;
    setActiveSlotIndex(index);
    setStep("slot-picker");
  };

  const handleSlotFolderPicked = (folderId: string, folderName: string) => {
    if (activeSlotIndex === null) return;
    const index = activeSlotIndex;
    setDraftRoots((prev) => {
      const next = [...prev];
      next[index] = { id: folderId, name: folderName };
      return next;
    });
    setActiveSlotIndex(null);
    setStep("mode");
  };

  const handleAddFolderPicked = (folderId: string, folderName: string) => {
    setDraftRoots((prev) => [...prev, { id: folderId, name: folderName }]);
    setMultiMode(true);
    setStep("mode");
  };

  const handleCancelDelete = useCallback(() => {
    setDeleteIndex(null);
  }, []);

  const handleConfirmDelete = () => {
    if (deleteIndex === null) return;
    const index = deleteIndex;
    setDraftRoots((prev) => prev.filter((_, i) => i !== index));
    setDeleteIndex(null);
  };

  const handleCancelConfirm = useCallback(() => {
    if (committingRef.current) return;
    setCommitFailed(false);
    setStep("mode");
  }, []);

  const handleConfirmCommit = () => {
    if (isInvalid || committingRef.current) return;
    committingRef.current = true;
    setIsCommitting(true);
    setCommitFailed(false);
    void (async () => {
      const committed = await runCommit(
        draftRoots.map((root) => ({ ...root })),
      );
      committingRef.current = false;
      setIsCommitting(false);
      if (committed) {
        onDone();
      } else {
        setCommitFailed(true);
      }
    })();
  };

  if (step === "slot-picker") {
    return (
      <FolderSelectionScreen
        token={token}
        initialFolderId={ROOT_FOLDER_ID}
        initialFolderHistory={[]}
        allowEscapeRoot={true}
        startAtDriveRoot={true}
        onSelectFolder={() => undefined}
        onSelectFolderWithName={handleSlotFolderPicked}
        onCancel={() => {
          setActiveSlotIndex(null);
          setStep("mode");
        }}
      />
    );
  }

  if (step === "add-picker") {
    return (
      <FolderSelectionScreen
        token={token}
        initialFolderId={ROOT_FOLDER_ID}
        initialFolderHistory={[]}
        allowEscapeRoot={true}
        startAtDriveRoot={true}
        onSelectFolder={() => undefined}
        onSelectFolderWithName={handleAddFolderPicked}
        onCancel={() => {
          setStep("mode");
        }}
      />
    );
  }

  // Same trigger language as MoreMenuTrigger; active styling signals edit mode.
  const settingsButton = (
    <button
      type="button"
      aria-label={t("folder_selection.edit_roots")}
      aria-pressed={isEditing}
      onClick={() => {
        setIsEditing((prev) => !prev);
      }}
      className={`relative h-10 w-10 flex items-center justify-center p-2 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-brand-primary/40 ${
        isEditing
          ? "bg-brand-primary/10 text-brand-text"
          : "text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a]"
      }`}
    >
      <Settings2 className="w-5 h-5" />
    </button>
  );

  const confirmButton = (
    <button
      type="button"
      disabled={isInvalid}
      onClick={() => {
        setStep("confirm");
      }}
      className={PRIMARY_BUTTON_CLASS}
    >
      <Check className="w-4 h-4" />
      {t("folder_selection.confirm")}
    </button>
  );

  const cancelButton = onCancel ? (
    <button type="button" onClick={onCancel} className={SECONDARY_BUTTON_CLASS}>
      {t("folder_selection.cancel")}
    </button>
  ) : null;

  // Settings entry is pinned bottom-left; actions stay right-aligned and only
  // surface in edit mode.
  const footer = (
    <div className="flex w-full items-center gap-3">
      {currentRoots.length > 0 && settingsButton}
      <div className="ml-auto flex min-h-10 items-center gap-3">
        {isEditing && cancelButton}
        {isEditing && draftRoots.length > 0 && confirmButton}
      </div>
    </div>
  );

  const visibleRoots = multiMode ? draftRoots : draftRoots.slice(0, 1);
  const showPlaceholder = !multiMode && draftRoots.length === 0;
  const canAddRoot = draftRoots.length < MAX_ROOT_FOLDERS;

  const modeContent = (
    <>
      <div className="flex flex-col gap-3">
        {visibleRoots.map((root, index) => (
          <RootSlotCard
            key={index}
            label={t("folder_selection.folder_slot", { index: index + 1 })}
            folderName={root.name}
            emptyLabel={t("folder_selection.choose_root_folder")}
            isEditable={isEditing}
            onClick={() => {
              handleRowClick(index);
            }}
            trailingAction={
              isEditing ? (
                <RootRowActions
                  rootCount={draftRoots.length}
                  onChangeRoot={() => {
                    handleRowClick(index);
                  }}
                  onRequestRemove={() => {
                    setDeleteIndex(index);
                  }}
                />
              ) : undefined
            }
          />
        ))}
        {showPlaceholder && (
          <RootSlotCard
            label={t("folder_selection.folder_slot", { index: 1 })}
            folderName={null}
            emptyLabel={t("folder_selection.choose_root_folder")}
            isEditable={isEditing}
            onClick={() => {
              handleRowClick(0);
            }}
          />
        )}
        {isEditing && canAddRoot && (
          <div className="ml-4">
            <button
              type="button"
              aria-label={t("folder_selection.add_root_folder")}
              onClick={() => {
                setStep("add-picker");
              }}
              className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 transition-all duration-300 bg-amber-100 dark:bg-amber-900/30 text-amber-500 hover:bg-amber-200 dark:hover:bg-amber-900/50 hover:shadow-md hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-brand-primary/40"
            >
              <FolderPlus className="w-6 h-6" />
            </button>
          </div>
        )}
      </div>
      {hasDuplicate && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("folder_selection.roots_duplicate")}
        </p>
      )}
    </>
  );

  const singleRoot = draftRoots.length === 1;

  return (
    <>
      <RootFolderSetupShell
        footer={footer}
        onCancel={onCancel}
        isInert={step === "confirm" || deleteIndex !== null}
      >
        {modeContent}
      </RootFolderSetupShell>
      <ConfirmDialog
        isOpen={step === "confirm"}
        title={
          singleRoot
            ? t("folder_selection.confirm_root_title")
            : t("folder_selection.confirm_roots_title")
        }
        body={
          singleRoot
            ? t("folder_selection.confirm_root_body")
            : t("folder_selection.confirm_roots_body", {
                totalCount: draftRoots.length,
              })
        }
        confirmLabel={t("folder_selection.confirm")}
        cancelLabel={t("folder_selection.cancel")}
        onClose={handleCancelConfirm}
        onConfirm={handleConfirmCommit}
        isOperating={isCommitting}
        errorMessage={
          commitFailed ? t("folder_selection.roots_commit_failed") : undefined
        }
      />
      <ConfirmDialog
        isOpen={deleteIndex !== null}
        title={t("folder_selection.remove_root_title")}
        body={t("folder_selection.remove_root_body")}
        confirmLabel={t("folder_selection.confirm")}
        cancelLabel={t("folder_selection.cancel")}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        isOperating={false}
      />
    </>
  );
}
