import { FolderOpen, Globe, Moon, MonitorDown, Download, HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LanguageDropdown } from "./components/LanguageDropdown";
import { ThemeDropdown } from "./components/ThemeDropdown";
import { CreditsSection } from "./components/CreditsSection";
import { ErrorLogSection } from "./components/ErrorLogSection";

import { ThemeType } from "../../hooks/useTheme";
import { clearAppCache } from "../../utils/cache";
import { open } from "@tauri-apps/plugin-dialog";
import { showErrorToast, showSuccessToast } from "../../utils/simpleToast";
import { setCustomDownloadPath, getEffectiveDownloadPath } from "../../utils/downloadPath";
import { truncatePathMiddle } from "../../utils/truncatePath";
import { useEffect, useState } from "react";

interface SettingsTabProps {
  theme: ThemeType;
  setTheme: (t: ThemeType) => void;
  minimizeToTray: boolean;
  setMinimizeToTray: (minimize: boolean) => void;
  setShowFolderSelection: (val: boolean) => void;
  setShowTrashScreen: (val: boolean) => void;
}

export function SettingsTab({
  theme, setTheme,
  minimizeToTray, setMinimizeToTray,
  setShowFolderSelection,
  setShowTrashScreen,
}: SettingsTabProps) {
  const { t } = useTranslation();
  const [downloadPath, setDownloadPath] = useState<string>("");

  useEffect(() => {
    getEffectiveDownloadPath().then(setDownloadPath);
  }, []);

  const handlePickDownloadPath = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('settings.select_download_folder') || 'Select Download Folder'
      });
      if (selected) {
        setCustomDownloadPath(selected);
        setDownloadPath(selected);
      }
    } catch (e) {
      showErrorToast(t('settings.select_folder_error') || 'Failed to select folder');
    }
  };

  return (
    <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto px-8 py-10 relative transition-colors duration-300">
      {/* Signature Top Gradient */}
      <div className="absolute top-0 left-0 right-0 h-48 bg-gradient-to-b from-[#4285F4]/10 to-transparent pointer-events-none" />

      <div className="max-w-3xl mx-auto relative z-10">
        <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white mb-10 tracking-tight">
          {t('settings.title') || 'Settings'}
        </h1>

        <div className="space-y-8">
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-bold text-[#4285F4] uppercase tracking-wider mb-2">{t('settings.music_library')}</h2>
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
                  <FolderOpen className="w-6 h-6 text-[#4285F4]" />
                </div>
                <div>
                  <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('settings.google_drive_folder')}</p>
                </div>
              </div>
              <button
                onClick={() => setShowFolderSelection(true)}
                className="px-5 py-2.5 rounded-xl bg-[#4285F4] hover:bg-[#3367d6] text-white text-sm font-semibold transition-all transform active:scale-[0.97] shadow-[0_4px_12px_rgba(66,133,244,0.3)] hover:shadow-[0_6px_16px_rgba(66,133,244,0.4)] flex items-center gap-2"
              >
                <FolderOpen className="w-4 h-4" />
                {t('settings.change_folder')}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2 mt-6">
            <h2 className="text-sm font-bold text-[#4285F4] uppercase tracking-wider mb-2">{t('settings.preferences')}</h2>
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
                  <Globe className="w-6 h-6 text-[#4285F4]" />
                </div>
                <div>
                  <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('settings.language')}</p>
                </div>
              </div>
              <LanguageDropdown />
            </div>

            <div className="flex items-center justify-between py-4">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
                  <Moon className="w-6 h-6 text-[#4285F4]" />
                </div>
                <div>
                  <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('settings.theme')}</p>
                </div>
              </div>
              <ThemeDropdown currentTheme={theme} onChange={setTheme} />
            </div>

            {/* Close Behavior Setting */}
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
                  <MonitorDown className="w-6 h-6 text-[#4285F4]" />
                </div>
                <div>
                  <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('settings.minimize_to_tray') || 'Minimize to System Tray'}</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={minimizeToTray}
                  onChange={e => setMinimizeToTray(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 dark:bg-[#2A2A2A] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#4285F4]"></div>
              </label>
            </div>

            {/* Download Location Setting */}
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
                  <Download className="w-6 h-6 text-[#4285F4]" />
                </div>
                <div className="min-w-0">
                  <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('settings.download_location') || 'Download Location'}</p>
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
                  onClick={handlePickDownloadPath}
                  className="px-5 py-2.5 rounded-xl bg-[#4285F4] hover:bg-[#3367d6] text-white text-sm font-semibold transition-all transform active:scale-[0.97] shadow-[0_4px_12px_rgba(66,133,244,0.3)] hover:shadow-[0_6px_16px_rgba(66,133,244,0.4)] flex items-center gap-2"
                >
                  <FolderOpen className="w-4 h-4" />
                  {t('settings.change_path') || 'Change Path'}
                </button>
              </div>
            </div>
          </div>

          {/* Data Management */}
          <div className="flex flex-col gap-2 mt-6 mb-8">
            <h2 className="text-sm font-bold text-[#4285F4] uppercase tracking-wider mb-2">{t('settings.data_management') || 'Data Management'}</h2>
            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
                  <svg className="w-6 h-6 text-[#4285F4]" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </div>
                <div className="max-w-[320px]">
                  <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('settings.trash') || 'Trash'}</p>
                </div>
              </div>

              <button
                onClick={() => setShowTrashScreen(true)}
                className="px-5 py-2.5 bg-[#4285F4] hover:bg-[#3367d6] text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent"
              >
                {t('settings.open_trash') || 'Open Trash'}
              </button>
            </div>

            <div className="flex items-center justify-between py-4 pb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
                  <HardDrive className="w-6 h-6 text-[#4285F4]" />
                </div>
                <div className="max-w-[320px]">
                  <p className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('settings.clear_cache', 'Clear App Cache')}</p>
                </div>
              </div>

              <button
                onClick={async () => {
                  try {
                    await clearAppCache();
                    showSuccessToast(t('settings.clear_cache_success', 'Cache cleared successfully!'));
                  } catch (e) {
                    showErrorToast(t('settings.clear_cache_error', 'Failed to clear cache.'));
                  }
                }}
                className="px-5 py-2.5 bg-[#4285F4] hover:bg-[#3367d6] text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent"
              >
                {t('settings.clear_cache_btn', 'Clear Now')}
              </button>
            </div>
          </div>

          <CreditsSection />

          <ErrorLogSection />
        </div>
      </div>
    </main>
  );
}
