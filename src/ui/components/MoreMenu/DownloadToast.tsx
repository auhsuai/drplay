import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert, Info } from "lucide-react";

/** Which icon (and live-region politeness) a download toast shows.
 * `success` is the default only for callers that predate kinds (the
 * DEV-only debug trigger); every real flow passes its kind explicitly. */
export type DownloadToastKind = "success" | "error" | "info";

/** Single spacing for every toast: 12px between stacked toasts, 16px
 * from the content-area's left edge, 80px from the bottom (clears the
 * PlayerBar — same bottom/right offsets as the imperative simpleToast,
 * `bottom: 80px; right: 16px` in App.css). One token, both toast systems. */
export const DOWNLOAD_TOAST_STACK_ID = "download-toast-stack";

/**
 * Read lazily inside the component (not at module scope): test files
 * that hand-mock lucide-react import this module through MoreMenu, and
 * a module-level dereference of a mocked-away icon throws at import
 * even when no toast ever renders.
 */
function getToastIcon(kind: DownloadToastKind): {
  Icon: typeof Check;
  className: string;
} {
  switch (kind) {
    case "success":
      return {
        Icon: Check,
        className: "w-4 h-4 text-green-600 dark:text-green-400 shrink-0",
      };
    // Errors (incl. the no_space "not enough free space" toast) show a
    // red "!" — never the green check. The old component hardcoded
    // <Check> for every message, so a failed download looked like a
    // completed one.
    case "error":
      return {
        Icon: CircleAlert,
        className: "w-4 h-4 text-red-600 dark:text-red-400 shrink-0",
      };
    // Neutral progress/cancelled lines: neither a success nor a failure.
    case "info":
      return {
        Icon: Info,
        className: "w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0",
      };
  }
}

/**
 * The one shared stack every DownloadToast portals into: a single flex
 * column with a uniform 12px gap. Before this, each toast was its own
 * `absolute bottom-20 left-0` portal, so two toasts visible at once
 * (single-file + bulk) rendered on top of each other at exactly the same
 * spot with no gap at all.
 */
function ensureToastStack(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(DOWNLOAD_TOAST_STACK_ID);
  if (existing) return existing;
  const stack = document.createElement("div");
  stack.id = DOWNLOAD_TOAST_STACK_ID;
  stack.className =
    "absolute bottom-20 left-4 z-[9999] flex flex-col gap-3 w-[min(90vw,28rem)] pointer-events-none";
  const parent = document.getElementById("content-area") ?? document.body;
  parent.appendChild(stack);
  return stack;
}

interface DownloadToastProps {
  message: string;
  kind?: DownloadToastKind;
}

export function DownloadToast({
  message,
  kind = "success",
}: DownloadToastProps) {
  // Lazily created once per mount (getElementById guard keeps StrictMode's
  // double render from making two stacks). Removed on unmount only when
  // empty, so a second toast sharing the stack is never orphaned.
  const [stackEl] = useState<HTMLElement | null>(() => ensureToastStack());
  useEffect(() => {
    return () => {
      const stack = document.getElementById(DOWNLOAD_TOAST_STACK_ID);
      if (stack && stack.childElementCount === 0) {
        stack.remove();
      }
    };
  }, []);

  if (!stackEl) return null;

  const { Icon, className } = getToastIcon(kind);
  const isError = kind === "error";

  return createPortal(
    <div
      // ARIA live region (WCAG 4.1.3): errors announce assertively, the
      // rest politely — mirroring simpleToast (role=alert for errors,
      // role=status otherwise).
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className="animate-in slide-in-from-left-5 fade-in duration-300 w-full pointer-events-none"
    >
      <div className="bg-white dark:bg-[#2a2b2f] text-gray-900 dark:text-white rounded-full px-5 py-3 flex items-center gap-3">
        <Icon className={className} />
        <p className="text-sm font-medium truncate" title={message}>
          {message}
        </p>
      </div>
    </div>,
    stackEl,
  );
}
