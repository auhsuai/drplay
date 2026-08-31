import React, { useEffect, useRef, useState } from "react";
import { CloudUpload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { startUploads, type UploadSeed } from "../../utils/uploadManager";
import { useDriveStore } from "../../store/driveStore";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { basename } from "../../utils/pathUtils";
import { IS_MOBILE } from "../../utils/platform";
import { useClickOutside } from "../../hooks/useClickOutside";

const UPLOAD_BUTTON_MODULE = "UploadButton";
// Extensions the file picker filters to (no leading dot, per DialogFilter
// docs). m4a is excluded: the app cannot play it on Android (ExoPlayer cannot
// stream non-faststart moov-at-tail files) so uploading it would produce an
// invisible file — the sync queries never match it.
const AUDIO_FILE_EXTENSIONS: ReadonlyArray<string> = [
  "mp3",
  "flac",
  "wav",
  "ogg",
  "aac",
  "opus",
];
// Matches the Sidebar toggle-button style (Sidebar.tsx) — gray, hover to
// dark, fixed icon-sized hit area.
const TOGGLE_BUTTON_CLASS =
  "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-all duration-300 w-6 h-6 flex items-center justify-center shrink-0";
const MENU_ITEM_CLASS =
  "w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-brand-primary rounded-md transition-all";

export interface UploadButtonProps {
  token?: string | null | undefined;
  // Uploads only make sense inside My Drive; elsewhere the button is dimmed
  // and shows a not-allowed cursor instead of opening the menu.
  disabled?: boolean;
}

// The dialog returns string[] with multiple:true and string with
// directory:true — normalize both shapes (plus a defensive single-string
// file result) to a uniform string[] of non-empty paths.
function normalizePaths(selected: unknown): string[] {
  if (Array.isArray(selected)) {
    return selected.filter((p): p is string => typeof p === "string");
  }
  if (typeof selected === "string") {
    return [selected];
  }
  return [];
}

export function UploadButton({ token, disabled = false }: UploadButtonProps) {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Menu lifecycle listeners (MoreMenu pattern): close on outside mousedown
  // (useClickOutside) or Escape. Listeners exist only while the menu is open.
  useClickOutside(
    wrapperRef,
    () => {
      setIsMenuOpen(false);
    },
    isMenuOpen,
  );

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMenuOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen]);

  // Mobile has no upload: no native file dialog story, and the upload
  // pipeline (fs scope extension, resumable session) is desktop-only. The
  // gate lives in the component so every mount site is covered at once.
  if (!token || IS_MOBILE) return null;

  const handleToggleMenu = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    setIsMenuOpen((prev) => !prev);
  };

  const handleUploadFiles = async () => {
    if (!token) return;
    setIsMenuOpen(false);
    try {
      const selected = await open({
        directory: false,
        multiple: true,
        filters: [
          {
            name: t("upload.audio_files"),
            extensions: [...AUDIO_FILE_EXTENSIONS],
          },
        ],
      });
      const paths = normalizePaths(selected);
      if (paths.length === 0) return;
      const parentId = useDriveStore.getState().currentFolderId;
      const seeds: UploadSeed[] = paths.map((path) => ({
        name: basename(path),
        isFolder: false,
        parentId,
        diskPath: path,
      }));
      startUploads(seeds, token);
    } catch (err) {
      void captureError({
        level: "error",
        source: UPLOAD_BUTTON_MODULE,
        message: `open-file-dialog-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("upload.upload_error"));
    }
  };

  const handleUploadFolder = async () => {
    if (!token) return;
    setIsMenuOpen(false);
    try {
      const selected = await open({ directory: true });
      if (typeof selected !== "string") return;
      const parentId = useDriveStore.getState().currentFolderId;
      startUploads(
        [
          {
            name: basename(selected),
            isFolder: true,
            parentId,
            diskPath: selected,
          },
        ],
        token,
      );
    } catch (err) {
      void captureError({
        level: "error",
        source: UPLOAD_BUTTON_MODULE,
        message: `open-folder-dialog-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("upload.upload_error"));
    }
  };

  return (
    <div
      className="relative shrink-0"
      ref={wrapperRef}
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <button
        onClick={handleToggleMenu}
        title={disabled ? t("upload.disabled_title") : t("upload.button_title")}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-disabled={disabled}
        className={`${TOGGLE_BUTTON_CLASS} ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
      >
        {/* CloudUpload = lucide "cloud-arrow-up"; UploadCloud is the deprecated alias. */}
        <CloudUpload className="w-5 h-5" />
      </button>
      {isMenuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-50 w-40 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 flex flex-col animate-in fade-in zoom-in-95 duration-200"
        >
          <button
            role="menuitem"
            onClick={() => {
              void handleUploadFiles();
            }}
            className={MENU_ITEM_CLASS}
          >
            {t("upload.upload_file")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              void handleUploadFolder();
            }}
            className={MENU_ITEM_CLASS}
          >
            {t("upload.upload_folder")}
          </button>
        </div>
      )}
    </div>
  );
}
