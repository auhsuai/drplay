import { useEffect, useRef, useState } from "react";
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
  isPicking: boolean;
  handlePickDownloadPath: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [downloadPath, setDownloadPath] = useState<string>("");
  const [isPicking, setIsPicking] = useState(false);
  // Synchronous re-entrancy guard (mirror useSeedImport): `isPicking` only
  // flips true after React flushes state, so two clicks in the same tick
  // would still open two native dialogs without the ref.
  const busyRef = useRef(false);

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
    if (busyRef.current) return;
    busyRef.current = true;
    setIsPicking(true);
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
    } catch (err) {
      await captureError({
        level: "error",
        source: "SettingsTab",
        message: `open-download-folder-dialog-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("settings.select_folder_error"));
    } finally {
      busyRef.current = false;
      setIsPicking(false);
    }
  };

  return { downloadPath, isPicking, handlePickDownloadPath };
}
