import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { DEBUG_EVENTS, dispatchDebugEvent } from "./debugEvents";

// Below RateLimitModal (z-[10000]) and ErrorBoundary (z-[10002]) on purpose:
// the debug overlay must never cover the app's blocking overlays.
const DEBUG_PANEL_Z_INDEX = "z-[9000]";

const DEBUG_BUTTON_CLASS =
  "px-3 py-1.5 rounded-lg text-sm text-left bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors";

export function DebugSection({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <section className="px-3 py-2 border-t border-gray-100 dark:border-gray-800">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {title}
      </h3>
      {children ? (
        <div className="flex flex-col gap-1.5">{children}</div>
      ) : null}
    </section>
  );
}

export function DebugPanel() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d") {
        // Global app-debug shortcut: works even while typing, unlike the
        // PlayerBar transport shortcuts which guard against input focus.
        setIsOpen((prev) => !prev);
        return;
      }
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className={`fixed bottom-4 right-4 ${DEBUG_PANEL_Z_INDEX} w-80 max-h-[70vh] overflow-y-auto bg-white dark:bg-[#1f2024] border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl`}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-800">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          Debug UI
        </h2>
        <button
          onClick={() => {
            setIsOpen(false);
          }}
          aria-label="Close debug panel"
          className="p-1 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
        >
          <X size={16} />
        </button>
      </div>
      <div className="py-2">
        <DebugSection title="Errors">
          <button
            onClick={() => {
              dispatchDebugEvent(DEBUG_EVENTS.RATE_LIMIT, undefined);
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Rate limit modal (403/quota)
          </button>
        </DebugSection>
        <DebugSection title="Player" />
        <DebugSection title="Storage quota" />
        <DebugSection title="Empty states" />
        <DebugSection title="Loading / MainContent" />
        <DebugSection title="Toasts" />
      </div>
    </div>
  );
}
