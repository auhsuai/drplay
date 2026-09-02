import {
  FolderOpen,
  Globe,
  Moon,
  Download,
  Eraser,
  Archive,
  Cloud,
  Headphones,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { LanguageDropdown } from "./components/LanguageDropdown";
import { ThemeDropdown } from "./components/ThemeDropdown";
import { CreditsSection } from "./components/CreditsSection";
import { ErrorLogSection } from "./components/ErrorLogSection";
import { CacheManagerModal } from "./components/CacheManagerModal";
import { MobileUserHeader } from "./components/MobileUserHeader";
import { UploadsSection } from "./components/UploadsSection";
import { SettingsRow, SettingsSectionHeading } from "./components/SettingsRow";
import { useDownloadPathSetting } from "./useDownloadPathSetting";
import { useSeedImport } from "./useSeedImport";

import type { ThemeType } from "../../hooks/useTheme";
import { useHardwareBack } from "../../hooks/useHardwareBack";
import { useState } from "react";
import { IS_MOBILE } from "../../utils/platform";
import { truncatePathMiddle } from "../../utils/truncatePath";
import type { UserProfile } from "../../types";

interface SettingsTabProps {
  theme: ThemeType;
  setTheme: (t: ThemeType) => void;
  backgroundPlayback: boolean;
  setBackgroundPlayback: (enabled: boolean) => void;
  setShowFolderSelection: (val: boolean) => void;
  setShowTrashScreen: (val: boolean) => void;
  userProfile?: UserProfile | null;
  onLogout: () => void;
}

export function SettingsTab({
  theme,
  setTheme,
  backgroundPlayback,
  setBackgroundPlayback,
  setShowFolderSelection,
  setShowTrashScreen,
  userProfile,
  onLogout,
}: SettingsTabProps) {
  const { t } = useTranslation();
  const { downloadPath, handlePickDownloadPath } = useDownloadPathSetting();
  const [showCacheManager, setShowCacheManager] = useState(false);
  const { importingSeed, handleImportSeed } = useSeedImport();

  // Hardware back (mobile): closes the CacheManagerModal when it owns the
  // foreground — without this, the back press falls through to the tab →
  // Home chain and pops the Settings tab off-screen instead.
  useHardwareBack(() => {
    setShowCacheManager(false);
    return true;
  }, showCacheManager);

  // Background-playback row label (mobile only). Resolved from the shared
  // translation resources — no per-locale fallback needed.
  const backgroundPlaybackLabel = (): string =>
    t("settings.background_playback");

  return (
    <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto px-8 py-10 relative transition-colors duration-300">
      {/* Signature Top Gradient */}
      <div className="absolute top-0 left-0 right-0 h-48 bg-gradient-to-b from-brand-primary/10 to-transparent pointer-events-none" />

      <div className="max-w-3xl mx-auto relative z-10">
        <h1
          className={`${IS_MOBILE ? "text-xl" : "text-3xl"} font-extrabold text-gray-900 dark:text-white mb-10 tracking-tight`}
        >
          {t("settings.title")}
        </h1>

        {IS_MOBILE && (
          <MobileUserHeader userProfile={userProfile} onLogout={onLogout} />
        )}

        <div className="space-y-8">
          <div className="flex flex-col gap-2">
            <SettingsSectionHeading title={t("settings.music_library")} />
            <SettingsRow
              icon={<Cloud className="w-6 h-6 text-brand-primary" />}
              title={t("settings.google_drive_folder")}
            >
              <button
                onClick={() => {
                  setShowFolderSelection(true);
                }}
                className="px-2.5 py-1.5 bg-brand-primary hover:bg-brand-hover text-white text-xs rounded-lg font-medium transition-all transform active:scale-95 shadow-sm border border-transparent flex items-center gap-1.5 whitespace-nowrap"
              >
                <FolderOpen className="w-4 h-4" />
                {t("settings.change_folder")}
              </button>
            </SettingsRow>
          </div>

          <UploadsSection />

          <div className="flex flex-col gap-2 mt-6">
            <SettingsSectionHeading title={t("settings.preferences")} />
            <SettingsRow
              icon={<Globe className="w-6 h-6 text-brand-primary" />}
              title={t("settings.language")}
            >
              <LanguageDropdown />
            </SettingsRow>

            <SettingsRow
              className="flex items-center justify-between py-4"
              icon={<Moon className="w-6 h-6 text-brand-primary" />}
              title={t("settings.theme")}
            >
              <ThemeDropdown currentTheme={theme} onChange={setTheme} />
            </SettingsRow>

            {/* Close Behavior Setting (Task 3 mobile-polish): "Chạy nhạc
                nền" background playback toggle — OFF pauses the native
                engine when the app goes hidden, ON keeps the foreground
                service playing. translation.json is owned by the cover
                branch, so the label rides on t(key, defaultValue) with a
                language-aware fallback. Desktop renders no close-behavior
                row (tray support removed — Android-only app). */}
            {IS_MOBILE ? (
              <SettingsRow
                icon={<Headphones className="w-6 h-6 text-brand-primary" />}
                title={backgroundPlaybackLabel()}
              >
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
              </SettingsRow>
            ) : null}

            {/* Download Location Setting */}
            <SettingsRow
              leftClassName="flex items-center gap-4 min-w-0"
              textClassName="min-w-0"
              icon={<Download className="w-6 h-6 text-brand-primary" />}
              title={t("settings.download_location")}
              subtitle={
                <p
                  title={downloadPath}
                  className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-[280px] sm:max-w-[400px]"
                >
                  {truncatePathMiddle(downloadPath)}
                </p>
              }
            >
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => {
                    void handlePickDownloadPath();
                  }}
                  className="px-2.5 py-1.5 bg-brand-primary hover:bg-brand-hover text-white text-xs rounded-lg font-medium transition-all transform active:scale-95 shadow-sm border border-transparent flex items-center gap-1.5 whitespace-nowrap"
                >
                  <FolderOpen className="w-4 h-4" />
                  {t("settings.change_path")}
                </button>
              </div>
            </SettingsRow>
          </div>

          {/* Data Management */}
          <div className="flex flex-col gap-2 mt-6 mb-8">
            <SettingsSectionHeading title={t("settings.data_management")} />
            <SettingsRow
              icon={
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
              }
              title={t("settings.trash")}
              textClassName="max-w-[320px]"
            >
              <button
                onClick={() => {
                  setShowTrashScreen(true);
                }}
                className="px-2.5 py-1.5 bg-brand-primary hover:bg-brand-hover text-white text-xs rounded-lg font-medium transition-all transform active:scale-95 shadow-sm border border-transparent whitespace-nowrap"
              >
                {t("settings.open_trash")}
              </button>
            </SettingsRow>

            <SettingsRow
              icon={<Eraser className="w-6 h-6 text-brand-primary" />}
              title={t("settings.clear_cache")}
              textClassName="max-w-[320px]"
            >
              <button
                onClick={() => {
                  setShowCacheManager(true);
                }}
                className="px-2.5 py-1.5 bg-brand-primary hover:bg-brand-hover text-white text-xs rounded-lg font-medium transition-all transform active:scale-95 shadow-sm border border-transparent whitespace-nowrap"
              >
                {t("settings.clear_cache_btn")}
              </button>
            </SettingsRow>

            {/* Seed offline import (desktop-only: Android never reaches the
                Rust import_metadata_seed command — no folder of covers to
                restore on-device, and the dialog invoke would fail). */}
            {!IS_MOBILE && (
              <SettingsRow
                icon={<Archive className="w-6 h-6 text-brand-primary" />}
                title={t("settings.import_seed")}
                textClassName="max-w-[320px]"
              >
                <button
                  onClick={() => {
                    void handleImportSeed();
                  }}
                  disabled={importingSeed}
                  className="px-2.5 py-1.5 bg-brand-primary hover:bg-brand-hover text-white text-xs rounded-lg font-medium transition-all transform active:scale-95 shadow-sm border border-transparent disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {t("settings.import_seed")}
                </button>
              </SettingsRow>
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
