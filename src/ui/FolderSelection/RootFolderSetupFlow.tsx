import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { captureError } from "../../utils/errorLog";
import type { RootFolder } from "../../utils/rootFolders";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FolderSelectionScreen } from "./FolderSelectionScreen";
import { AdditionalRootsDropdown } from "./rootFolderSetup/AdditionalRootsDropdown";
import { RootFolderSetupShell } from "./rootFolderSetup/RootFolderSetupShell";
import { RootSlotCard } from "./rootFolderSetup/RootSlotCard";

const SLOT_COUNT = 5;
const MAX_ADDITIONAL_ROOTS = SLOT_COUNT - 1;
const ADDITIONAL_ROOT_OPTIONS = [1, 2, 3, 4] as const;

const PRIMARY_BUTTON_CLASS =
  "flex items-center justify-center gap-2 bg-brand-primary hover:bg-brand-hover text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all transform active:scale-[0.98] shadow-sm disabled:opacity-50 disabled:cursor-not-allowed";
const SECONDARY_BUTTON_CLASS =
  "px-5 py-2.5 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

type Step = "mode" | "editor" | "single-picker" | "slot-picker" | "confirm";

export interface RootFolderSetupFlowProps {
  token: string;
  currentRoots: RootFolder[];
  onCommit: (roots: RootFolder[]) => Promise<boolean>;
  onDone: () => void;
  onCancel?: (() => void) | undefined;
}

function buildInitialSlots(currentRoots: RootFolder[]): (RootFolder | null)[] {
  return Array.from(
    { length: SLOT_COUNT },
    (_, index) => currentRoots[index] ?? null,
  );
}

function initialAdditionalCount(currentRoots: RootFolder[]): number {
  return Math.min(Math.max(currentRoots.length - 1, 1), MAX_ADDITIONAL_ROOTS);
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
  const [useMulti, setUseMulti] = useState(currentRoots.length > 1);
  const [additionalCount, setAdditionalCount] = useState(() =>
    initialAdditionalCount(currentRoots),
  );
  const [slots, setSlots] = useState<(RootFolder | null)[]>(() =>
    buildInitialSlots(currentRoots),
  );
  const [activeSlotIndex, setActiveSlotIndex] = useState<number | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitFailed, setCommitFailed] = useState(false);
  const [isAdditionalMenuOpen, setIsAdditionalMenuOpen] = useState(false);
  const committingRef = useRef(false);

  const requiredCount = 1 + additionalCount;
  const requiredSlots = useMemo(
    () => slots.slice(0, requiredCount),
    [slots, requiredCount],
  );
  const requiredRoots = useMemo(
    () => requiredSlots.filter((slot): slot is RootFolder => slot !== null),
    [requiredSlots],
  );
  const hasEmptyRequired = requiredSlots.some((slot) => slot === null);
  const hasDuplicate =
    new Set(requiredRoots.map((root) => root.id)).size !== requiredRoots.length;
  const isInvalid = hasEmptyRequired || hasDuplicate;

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

  const commitSingleRoot = useCallback(
    async (folderId: string, folderName: string) => {
      const committed = await runCommit([{ id: folderId, name: folderName }]);
      if (committed) onDone();
    },
    [onDone, runCommit],
  );

  // Window CAPTURE: the setup overlay must swallow Escape before the layers
  // behind it (drawer/menu listeners run in the bubble phase). While the
  // additional-roots menu is open the flow stands down so the press closes
  // only that menu.
  useEffect(() => {
    if (step !== "mode" && step !== "editor") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isAdditionalMenuOpen) return;
      event.stopPropagation();
      onCancel?.();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [step, onCancel, isAdditionalMenuOpen]);

  const handleContinue = () => {
    setCommitFailed(false);
    setStep(useMulti ? "editor" : "single-picker");
  };

  const handleSlotClick = (index: number) => {
    if (index >= requiredCount) return;
    setActiveSlotIndex(index);
    setStep("slot-picker");
  };

  const handleSlotFolderPicked = (folderId: string, folderName: string) => {
    if (activeSlotIndex === null) return;
    const index = activeSlotIndex;
    setSlots((prev) => {
      const next = [...prev];
      next[index] = { id: folderId, name: folderName };
      return next;
    });
    setActiveSlotIndex(null);
    setStep("editor");
  };

  const handleCancelConfirm = useCallback(() => {
    if (committingRef.current) return;
    setCommitFailed(false);
    setStep("editor");
  }, []);

  const handleConfirmCommit = () => {
    if (isInvalid || committingRef.current) return;
    committingRef.current = true;
    setIsCommitting(true);
    setCommitFailed(false);
    void (async () => {
      const committed = await runCommit(
        requiredRoots.map((root) => ({ ...root })),
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

  if (step === "single-picker") {
    return (
      <FolderSelectionScreen
        token={token}
        initialFolderId={ROOT_FOLDER_ID}
        initialFolderHistory={[]}
        allowEscapeRoot={true}
        startAtDriveRoot={true}
        onSelectFolder={() => undefined}
        onSelectFolderWithName={(folderId, folderName) => {
          void commitSingleRoot(folderId, folderName);
        }}
        onCancel={() => {
          setStep("mode");
        }}
      />
    );
  }

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
          setStep("editor");
        }}
      />
    );
  }

  const modeFooter = (
    <div className="flex w-full items-center justify-end gap-3">
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className={SECONDARY_BUTTON_CLASS}
        >
          {t("folder_selection.cancel")}
        </button>
      )}
      <button
        type="button"
        onClick={handleContinue}
        className={PRIMARY_BUTTON_CLASS}
      >
        {t("folder_selection.continue")}
      </button>
    </div>
  );

  const editorFooter = (
    <>
      <button
        type="button"
        onClick={() => {
          setStep("single-picker");
        }}
        className={SECONDARY_BUTTON_CLASS}
      >
        {t("folder_selection.use_single_root")}
      </button>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setStep("mode");
          }}
          className={SECONDARY_BUTTON_CLASS}
        >
          {t("common.back")}
        </button>
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
      </div>
    </>
  );

  const modeContent = (
    <>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {t("folder_selection.multi_root_question")}
        </p>
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={useMulti}
            onChange={(event) => {
              setUseMulti(event.target.checked);
            }}
            aria-label={t("folder_selection.multi_root_question")}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-gray-200 dark:bg-[#2A2A2A] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-primary"></div>
        </label>
      </div>
      {useMulti && (
        <AdditionalRootsDropdown
          label={t("folder_selection.additional_roots")}
          value={additionalCount}
          options={ADDITIONAL_ROOT_OPTIONS}
          onChange={setAdditionalCount}
          onOpenChange={setIsAdditionalMenuOpen}
        />
      )}
    </>
  );

  const editorContent = (
    <>
      <AdditionalRootsDropdown
        label={t("folder_selection.additional_roots")}
        value={additionalCount}
        options={ADDITIONAL_ROOT_OPTIONS}
        onChange={setAdditionalCount}
        onOpenChange={setIsAdditionalMenuOpen}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {slots.map((slot, index) => (
          <RootSlotCard
            key={index}
            label={t("folder_selection.folder_slot", { index: index + 1 })}
            folderName={slot?.name ?? null}
            disabled={index >= requiredCount}
            onClick={() => {
              handleSlotClick(index);
            }}
          />
        ))}
      </div>
      {hasDuplicate && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t("folder_selection.roots_duplicate")}
        </p>
      )}
    </>
  );

  return (
    <>
      <RootFolderSetupShell
        footer={step === "mode" ? modeFooter : editorFooter}
        onCancel={onCancel}
        isInert={step === "confirm"}
      >
        {step === "mode" ? modeContent : editorContent}
      </RootFolderSetupShell>
      <ConfirmDialog
        isOpen={step === "confirm"}
        title={t("folder_selection.confirm_roots_title")}
        body={t("folder_selection.confirm_roots_body", {
          totalCount: requiredRoots.length,
        })}
        confirmLabel={t("folder_selection.confirm")}
        cancelLabel={t("folder_selection.cancel")}
        onClose={handleCancelConfirm}
        onConfirm={handleConfirmCommit}
        isOperating={isCommitting}
        errorMessage={
          commitFailed ? t("folder_selection.roots_commit_failed") : undefined
        }
      />
    </>
  );
}
