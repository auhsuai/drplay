import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import {
  setCustomDownloadPath,
  getEffectiveDownloadPath,
  getMobileDownloadFolder,
  setMobileDownloadFolder,
} from "../../utils/downloadPath";
import { IS_MOBILE } from "../../utils/platform";

export function useDownloadPathSetting(): {
  downloadPath: string;
  handlePickDownloadPath: () => Promise<void>;
} {
  const { t } = useTranslation();
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
    } catch (err: unknown) {
      void captureError({
        level: "warn",
        source: "SettingsTab",
        message: `desktop-folder-pick-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("settings.select_folder_error"));
    }
  };

  return { downloadPath, handlePickDownloadPath };
}
