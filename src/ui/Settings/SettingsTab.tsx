import {
  FolderOpen,
  Globe,
  Moon,
  MonitorDown,
  Download,
  Eraser,
  Archive,
  Cloud,
  CloudUpload,
  Headphones,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { LanguageDropdown } from "./components/LanguageDropdown";
import { ThemeDropdown } from "./components/ThemeDropdown";
import { CreditsSection } from "./components/CreditsSection";
import { ErrorLogSection } from "./components/ErrorLogSection";
import { CacheManagerModal } from "./components/CacheManagerModal";

import type { ThemeType } from "../../hooks/useTheme";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { showErrorToast, showSuccessToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import {
  setCustomDownloadPath,
  getEffectiveDownloadPath,
  getMobileDownloadFolder,
  setMobileDownloadFolder,
} from "../../utils/downloadPath";
import { truncatePathMiddle } from "../../utils/truncatePath";
import { useEffect, useState } from "react";
import { IS_MOBILE } from "../../utils/platform";
import { subscribe, getEntries, cancelUpload } from "../../utils/uploadManager";
import type { UploadEntry } from "../../utils/uploadManager";

interface SettingsTabProps {
  theme: ThemeType;
  setTheme: (t: ThemeType) => void;
  minimizeToTray: boolean;
  setMinimizeToTray: (minimize: boolean) => void;
  backgroundPlayback: boolean;
  setBackgroundPlayback: (enabled: boolean) => void;
  setShowFolderSelection: (val: boolean) => void;
  setShowTrashScreen: (val: boolean) => void;
}

// Shown while a queued entry waits for its turn in the sequential upload queue.
const QUEUED_UPLOAD_LABEL = "Queued...";
// Upload progress is a 0..1 fraction; the UI renders it as a percentage.
const PROGRESS_PERCENT_SCALE = 100;

// The in-progress uploads section only lists live entries — terminal
// (done/error) entries are pruned by the manager right after they notify.
function isActiveUpload(entry: UploadEntry): boolean {
  return entry.status === "queued" || entry.status === "uploading";
}

function uploadProgressLabel(entry: UploadEntry): string {
  if (entry.status === "uploading") {
    const percent = Math.round((entry.progress ?? 0) * PROGRESS_PERCENT_SCALE);
    return `${String(percent)}%`;
  }
  return QUEUED_UPLOAD_LABEL;
}

export function SettingsTab({
  theme,
  setTheme,
  minimizeToTray,
  setMinimizeToTray,
  backgroundPlayback,
  setBackgroundPlayback,
  setShowFolderSelection,
  setShowTrashScreen,
}: SettingsTabProps) {
  const { t, i18n } = useTranslation();
  // Task 8: setting rows compact one notch on mobile (16px -> 14px); desktop
  // keeps text-base — the string is byte-identical to the pre-task markup.
  const settingsRowTitle = `${IS_MOBILE ? "text-sm" : "text-base"} font-semibold text-gray-900 dark:text-gray-100`;
  // Mobile (Task 4 mobile-polish): the download row shows the SAF folder
  // NAME when one is picked, otherwise the app-storage default label — the
  // raw /data path is meaningless on a phone. Lazy initializer (the value
  // never changes after mount; picking updates setDownloadPath directly).
  // Desktop: starts empty, filled by the effect below with the real path.
  const [downloadPath, setDownloadPath] = useState<string>(() => {
    if (IS_MOBILE) {
      const folder = getMobileDownloadFolder();
      return folder
        ? folder.name
        : t("settings.download_location_default", {
            defaultValue: "App storage (default)",
          });
    }
    return "";
  });
  const [showCacheManager, setShowCacheManager] = useState(false);
  const [importingSeed, setImportingSeed] = useState(false);
  const [uploadEntries, setUploadEntries] = useState<UploadEntry[]>(getEntries);

  useEffect(() => {
    if (IS_MOBILE) return;
    void getEffectiveDownloadPath()
      .then(setDownloadPath)
      .catch((err: unknown) => {
        void captureError({
          level: "warn",
          source: "SettingsTab",
          message: `download-path-load-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }, []);

  // Live snapshot of the upload queue: subscribe returns an unsubscribe, so
  // the effect's cleanup unsubscribes on unmount (no leaked subscriber).
  useEffect(() => {
    const unsubscribeFromUploads = subscribe(() => {
      setUploadEntries(getEntries());
    });
    return unsubscribeFromUploads;
  }, []);

  const activeUploads = uploadEntries.filter(isActiveUpload);

  // Background-playback row label (mobile only). The key ships nowhere in
  // translation.json yet (cover branch owns the file) — fall back per
  // locale so the toggle reads "Chạy nhạc nền" in Vietnamese and
  // "Background playback" in English.
  const backgroundPlaybackLabel = (): string =>
    t("settings.background_playback", {
      defaultValue: i18n.language.toLowerCase().startsWith("vi")
        ? "Chạy nhạc nền"
        : "Background playback",
    });

  const handlePickDownloadPath = async () => {
    // Mobile (Task 4 mobile-polish): SAF folder picker via the
    // saf-download plugin (tauri-plugin-dialog has NO Android folder
    // picker — this is the fix for the previously dead button). The picked
    // content-URI tree grant is persisted by the plugin; we store the
    // {uri, name} pair so downloads land there. User cancel → no change.
    if (IS_MOBILE) {
      try {
        const folder = await invoke<{ uri: string; name: string }>(
          "plugin:saf-download|pick_folder",
        );
        setMobileDownloadFolder(folder);
        setDownloadPath(folder.name);
      } catch (err: unknown) {
        const message =
          err &&
          typeof err === "object" &&
          typeof (err as { message?: unknown }).message === "string"
            ? (err as { message: string }).message
            : String(err);
        if (message.includes("cancelled")) return;
        void captureError({
          level: "error",
          source: "SettingsTab",
          message: `mobile-folder-pick-failed: ${message}`,
        });
        showErrorToast(t("settings.select_folder_error"));
      }
      return;
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("settings.select_download_folder"),
      });
      if (selected) {
        setCustomDownloadPath(selected);
        setDownloadPath(selected);
      }
    } catch {
      showErrorToast(t("settings.select_folder_error"));
    }
  };

  // Seed offline import (2026-08-10): one-shot restore of a metadata+cover
  // backup produced by the Colab scanner. The picked zip is unpacked by Rust
  // (import_metadata_seed) into <app_cache_dir>/metadata + /covers; mounted
  // cards pick the data up on their next fetch (disk-first), already-mounted
  // placeholders refresh on re-mount — the toast is the import's own signal.
  interface ImportSeedStats {
    metadataCount: number;
    coverCount: number;
    skipped: number;
  }
  const handleImportSeed = async () => {
    if (importingSeed) return;
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: t("settings.import_seed"), extensions: ["zip"] }],
      });
      // Cancelled / no selection: nothing to import.
      if (typeof selected !== "string") return;
      setImportingSeed(true);
      try {
        const stats = await invoke<ImportSeedStats>("import_metadata_seed", {
          zipPath: selected,
        });
        showSuccessToast(
          t("settings.import_seed_success", {
            metadata: stats.metadataCount,
            covers: stats.coverCount,
            skipped: stats.skipped,
          }),
        );
      } catch (err) {
        await captureError({
          level: "error",
          source: "SettingsTab",
          message: `import-seed-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        showErrorToast(t("settings.import_seed_error"));
      } finally {
        setImportingSeed(false);
      }
    } catch (err) {
      await captureError({
        level: "error",
        source: "SettingsTab",
        message: `open-seed-dialog-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("settings.import_seed_error"));
    }
  };

  return (
    <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto px-8 py-10 relative transition-colors duration-300">
      {/* Signature Top Gradient */}
      <div className="absolute top-0 left-0 right-0 h-48 bg-gradient-to-b from-brand-primary/10 to-transparent pointer-events-none" />

      <div className="max-w-3xl mx-auto relative z-10">
        <h1
          className={`${IS_MOBILE ? "text-2xl" : "text-3xl"} font-extrabold text-gray-900 dark:text-white mb-10 tracking-tight`}
        >
          {t("settings.title")}
        </h1>

        <div className="space-y-8">
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-bold text-brand-primary uppercase tracking-wider mb-2">
              {t("settings.music_library")}
            </h2>
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                  <Cloud className="w-6 h-6 text-brand-primary" />
                </div>
                <div>
                  <p className={settingsRowTitle}>
                    {t("settings.google_drive_folder")}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowFolderSelection(true);
                }}
                className="px-5 py-2.5 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent flex items-center gap-2"
              >
                <FolderOpen className="w-4 h-4" />
                {t("settings.change_folder")}
              </button>
            </div>
          </div>

          {/* In-progress uploads: hidden entirely while the queue is idle.
              Entries disappear from this list the moment they turn terminal
              (manager notifies + prunes), so cancel keeps working live. */}
          {activeUploads.length > 0 && (
            <div className="flex flex-col gap-2 mt-6">
              <h2 className="text-sm font-bold text-brand-primary uppercase tracking-wider mb-2">
                {t("settings.uploads_section")}
              </h2>
              <div className="flex flex-col">
                {activeUploads.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between py-4 pb-6"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                        <CloudUpload className="w-6 h-6 text-brand-primary" />
                      </div>
                      <div className="min-w-0">
                        <p
                          title={entry.name}
                          className={`${settingsRowTitle} truncate`}
                        >
                          {truncatePathMiddle(entry.name)}
                        </p>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {uploadProgressLabel(entry)}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        cancelUpload(entry.id);
                      }}
                      className="px-4 py-2 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent flex items-center gap-2"
                    >
                      {t("settings.uploads_cancel")}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 mt-6">
            <h2 className="text-sm font-bold text-brand-primary uppercase tracking-wider mb-2">
              {t("settings.preferences")}
            </h2>
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                  <Globe className="w-6 h-6 text-brand-primary" />
                </div>
                <div>
                  <p className={settingsRowTitle}>{t("settings.language")}</p>
                </div>
              </div>
              <LanguageDropdown />
            </div>

            <div className="flex items-center justify-between py-4">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                  <Moon className="w-6 h-6 text-brand-primary" />
                </div>
                <div>
                  <p className={settingsRowTitle}>{t("settings.theme")}</p>
                </div>
              </div>
              <ThemeDropdown currentTheme={theme} onChange={setTheme} />
            </div>

            {/* Close Behavior Setting — desktop: minimize to tray
                (byte-identical); mobile (Task 3 mobile-polish): "Chạy nhạc
                nền" background playback toggle — OFF pauses the native
                engine when the app goes hidden, ON keeps the foreground
                service playing. translation.json is owned by the cover
                branch, so the label rides on t(key, defaultValue) with a
                language-aware fallback. */}
            {IS_MOBILE ? (
              <div className="flex items-center justify-between py-4 pb-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                    <Headphones className="w-6 h-6 text-brand-primary" />
                  </div>
                  <div>
                    <p className={settingsRowTitle}>
                      {backgroundPlaybackLabel()}
                    </p>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <span className="sr-only">{backgroundPlaybackLabel()}</span>
                  <input
                    type="checkbox"
                    checked={backgroundPlayback}
                    onChange={(e) => {
                      setBackgroundPlayback(e.target.checked);
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 dark:bg-[#2A2A2A] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-primary"></div>
                </label>
              </div>
            ) : (
              <div className="flex items-center justify-between py-4 pb-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                    <MonitorDown className="w-6 h-6 text-brand-primary" />
                  </div>
                  <div>
                    <p className={settingsRowTitle}>
                      {t("settings.minimize_to_tray")}
                    </p>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <span className="sr-only">
                    {t("settings.minimize_to_tray")}
                  </span>
                  <input
                    type="checkbox"
                    checked={minimizeToTray}
                    onChange={(e) => {
                      setMinimizeToTray(e.target.checked);
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-200 dark:bg-[#2A2A2A] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-primary"></div>
                </label>
              </div>
            )}

            {/* Download Location Setting */}
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                  <Download className="w-6 h-6 text-brand-primary" />
                </div>
                <div className="min-w-0">
                  <p className={settingsRowTitle}>
                    {t("settings.download_location")}
                  </p>
                  <p
                    title={downloadPath}
                    className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-[280px] sm:max-w-[400px]"
                  >
                    {truncatePathMiddle(downloadPath)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => {
                    void handlePickDownloadPath();
                  }}
                  className="px-5 py-2.5 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent flex items-center gap-2"
                >
                  <FolderOpen className="w-4 h-4" />
                  {t("settings.change_path")}
                </button>
              </div>
            </div>
          </div>

          {/* Data Management */}
          <div className="flex flex-col gap-2 mt-6 mb-8">
            <h2 className="text-sm font-bold text-brand-primary uppercase tracking-wider mb-2">
              {t("settings.data_management")}
            </h2>
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                  <svg
                    className="w-6 h-6 text-brand-primary"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    ></path>
                  </svg>
                </div>
                <div className="max-w-[320px]">
                  <p className={settingsRowTitle}>{t("settings.trash")}</p>
                </div>
              </div>

              <button
                onClick={() => {
                  setShowTrashScreen(true);
                }}
                className="px-5 py-2.5 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent"
              >
                {t("settings.open_trash")}
              </button>
            </div>

            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                  <Eraser className="w-6 h-6 text-brand-primary" />
                </div>
                <div className="max-w-[320px]">
                  <p className={settingsRowTitle}>
                    {t("settings.clear_cache")}
                  </p>
                </div>
              </div>

              <button
                onClick={() => {
                  setShowCacheManager(true);
                }}
                className="px-5 py-2.5 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent"
              >
                {t("settings.clear_cache_btn")}
              </button>
            </div>

            {/* Seed offline import (desktop-only: Android never reaches the
                Rust import_metadata_seed command — no folder of covers to
                restore on-device, and the dialog invoke would fail). */}
            {!IS_MOBILE && (
              <div className="flex items-center justify-between py-4 pb-6">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-brand-primary/10 flex items-center justify-center shrink-0">
                    <Archive className="w-6 h-6 text-brand-primary" />
                  </div>
                  <div className="max-w-[320px]">
                    <p className={settingsRowTitle}>
                      {t("settings.import_seed")}
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => {
                    void handleImportSeed();
                  }}
                  disabled={importingSeed}
                  className="px-5 py-2.5 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t("settings.import_seed")}
                </button>
              </div>
            )}
          </div>

          <CreditsSection />

          <ErrorLogSection />
        </div>

        <CacheManagerModal
          open={showCacheManager}
          onClose={() => {
            setShowCacheManager(false);
          }}
        />
      </div>
    </main>
  );
}
