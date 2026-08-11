import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { showErrorToast, showSuccessToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { DEBUG_EVENTS, dispatchDebugEvent } from "./debugEvents";

// Below RateLimitModal (z-[10000]) and ErrorBoundary (z-[10002]) on purpose:
// the debug overlay must never cover the app's blocking overlays.
const DEBUG_PANEL_Z_INDEX = "z-[9000]";

const DEBUG_BUTTON_CLASS =
  "px-3 py-1.5 rounded-lg text-sm text-left bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors";

// Player error presets: messages mirror the real AudioController / PlayerBar
// strings (lib/AudioController.ts, PlayerBar.tsx) so the debug banner reads
// exactly like a live failure. rate_limited / access_denied have no real
// emission site today — ErrorToast maps their icons (CloudOff / FileWarning),
// so the presets carry plain English messages instead.
const PLAYER_ERROR_PRESETS: ReadonlyArray<{
  code: string;
  label: string;
  message: string;
}> = [
  {
    code: "network_interrupted",
    label: "Player error: network_interrupted",
    message: "Mạng không ổn định, đang thử lại...",
  },
  {
    code: "format_error",
    label: "Player error: format_error",
    message: "File lỗi định dạng, đang bỏ qua...",
  },
  {
    code: "advance_stopped",
    label: "Player error: advance_stopped",
    message: "Drive is overloaded or locked — auto-playback paused.",
  },
  {
    code: "rate_limited",
    label: "Player error: rate_limited",
    message: "Request rate limit exceeded — try again later.",
  },
  {
    code: "access_denied",
    label: "Player error: access_denied",
    message: "Access denied — the file may no longer be available.",
  },
];

// Bytes per gigabyte (1024^3) — matches formatBytes' 1024-based units so the
// quota preset buttons read like the sidebar card ("40 GB" not "40 000 MB").
const GB = 1024 * 1024 * 1024;

// Storage quota presets: one button per card state. usageInDrive/limit mirror
// the DriveStorageQuota fields the sidebar card reads (driveTypes.ts); the
// card derives its 3 states from these two values (under 80% blue / over 80%
// blue+red / unlimited text).
const QUOTA_PRESETS: ReadonlyArray<{
  label: string;
  usageInDrive: number;
  limit: number | null;
}> = [
  {
    label: "Quota: under 80% (blue)",
    usageInDrive: 40 * GB,
    limit: 100 * GB,
  },
  {
    label: "Quota: over 80% (red)",
    usageInDrive: 95 * GB,
    limit: 100 * GB,
  },
  { label: "Quota: unlimited", usageInDrive: 50 * GB, limit: null },
];

// Toast/error-log debug messages: hardcoded English (dev-only surface, not
// shipped copy) EXCEPT the login toasts, which go through t() so the debug
// panel exercises the real translated strings used by LoginScreen.
const DEBUG_TOAST_MESSAGES = {
  error: "Debug error toast",
  success: "Debug success toast",
} as const;

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
  // Crash test: once armed, DebugPanel throws inside its render on purpose so
  // the app-level ErrorBoundary (main.tsx) shows its fallback. This is the
  // documented ErrorBoundary pattern (throw in render, caught by
  // getDerivedStateFromError). Deliberately no way to un-arm — the boundary
  // replaces the whole subtree, matching a real render crash.
  const [crashArmed, setCrashArmed] = useState(false);
  const { t } = useTranslation();

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

  if (crashArmed) {
    throw new Error("Debug crash test — ErrorBoundary fallback");
  }

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
          {PLAYER_ERROR_PRESETS.map((preset) => (
            <button
              key={preset.code}
              onClick={() => {
                dispatchDebugEvent(DEBUG_EVENTS.PLAYER_ERROR, {
                  code: preset.code,
                  message: preset.message,
                });
              }}
              className={DEBUG_BUTTON_CLASS}
            >
              {preset.label}
            </button>
          ))}
          <button
            onClick={() => {
              setCrashArmed(true);
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Crash UI (ErrorBoundary)
          </button>
        </DebugSection>
        <DebugSection title="Player" />
        <DebugSection title="Storage quota">
          {QUOTA_PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => {
                dispatchDebugEvent(DEBUG_EVENTS.QUOTA, {
                  usageInDrive: preset.usageInDrive,
                  limit: preset.limit,
                });
              }}
              className={DEBUG_BUTTON_CLASS}
            >
              {preset.label}
            </button>
          ))}
        </DebugSection>
        <DebugSection title="Empty states">
          <button
            onClick={() => {
              dispatchDebugEvent(DEBUG_EVENTS.PLAYLIST_EMPTY, undefined);
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Empty: Playlist
          </button>
          <button
            onClick={() => {
              dispatchDebugEvent(DEBUG_EVENTS.LIKED_EMPTY, undefined);
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Empty: Liked Songs
          </button>
          <button
            onClick={() => {
              dispatchDebugEvent(DEBUG_EVENTS.TRASH_EMPTY, undefined);
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Empty: Trash
          </button>
          <button
            onClick={() => {
              dispatchDebugEvent(DEBUG_EVENTS.FOLDERS_EMPTY, undefined);
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Empty: Folder selection
          </button>
        </DebugSection>
        <DebugSection title="Loading / MainContent" />
        <DebugSection title="Toasts">
          <button
            onClick={() => {
              showErrorToast(DEBUG_TOAST_MESSAGES.error);
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Error toast
          </button>
          <button
            onClick={() => {
              showSuccessToast(DEBUG_TOAST_MESSAGES.success);
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Success toast
          </button>
          <button
            onClick={() => {
              showErrorToast(t("login.cancelled"));
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Login: cancelled
          </button>
          <button
            onClick={() => {
              showErrorToast(t("login.timeout_error"));
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Login: timeout
          </button>
          <button
            onClick={() => {
              showErrorToast(t("login.failed"));
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Login: failed
          </button>
        </DebugSection>
        <DebugSection title="Error log">
          <button
            onClick={() => {
              void captureError({
                level: "error",
                source: "DebugPanel",
                message: "Debug seed error log entry",
              });
            }}
            className={DEBUG_BUTTON_CLASS}
          >
            Seed error log entry
          </button>
        </DebugSection>
      </div>
    </div>
  );
}
