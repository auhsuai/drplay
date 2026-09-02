import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import {
  setCustomDownloadPath,
  getEffectiveDownloadPath,
} from "../../utils/downloadPath";

export function useDownloadPathSetting(): {
  downloadPath: string;
  handlePickDownloadPath: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [downloadPath, setDownloadPath] = useState<string>("");

  useEffect(() => {
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

  return { downloadPath, handlePickDownloadPath };
}
