import { useTranslation } from "react-i18next";

interface DownloadProgressProps {
  downloaded: number;
  total: number | null;
}

export function DownloadProgress({ downloaded, total }: DownloadProgressProps) {
  const { t } = useTranslation();
  if (total && total > 0) {
    const pct = Math.round((downloaded / total) * 100);
    return (
      <span className="text-xs text-gray-500">
        {t("menu.downloading", { defaultValue: "Downloading..." })} {pct}%
      </span>
    );
  }
  // Unknown total: show downloaded bytes
  const mb = (downloaded / (1024 * 1024)).toFixed(1);
  return (
    <span className="text-xs text-gray-500">
      {t("menu.downloading", { defaultValue: "Downloading..." })} {mb} MB
    </span>
  );
}
