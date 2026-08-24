import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

// Shared WAI-ARIA APG dialog shell (F4): overlay + labelled dialog panel with
// focus-on-open / focus-restore and Escape/backdrop dismissal. The dismissal
// paths must all respect closeDisabled so a pending operation cannot be
// cancelled by accident.
interface ModalShellProps {
  labelledById: string;
  onClose: () => void;
  closeDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const PANEL_CLASS =
  "bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200";

export function ModalShell({
  labelledById,
  onClose,
  closeDisabled = false,
  initialFocusRef,
  children,
}: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Same guard as ImageCropperModal: remember the trigger element, move
    // focus into the dialog, restore focus when it unmounts.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusTarget = initialFocusRef?.current ?? panelRef.current;
    focusTarget?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, [initialFocusRef]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !closeDisabled) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, closeDisabled]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledById}
        tabIndex={-1}
        className={PANEL_CLASS}
      >
        {children}
      </div>
    </div>
  );
}
