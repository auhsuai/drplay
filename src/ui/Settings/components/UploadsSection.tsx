import { CloudUpload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cancelUpload } from "../../../utils/uploadManager";
import { truncatePathMiddle } from "../../../utils/truncatePath";
import { useActiveUploads, uploadProgressLabel } from "../useActiveUploads";
import { SettingsRow, SettingsSectionHeading } from "./SettingsRow";

export function UploadsSection() {
  const { t } = useTranslation();
  const activeUploads = useActiveUploads();
  // In-progress uploads: hidden entirely while the queue is idle.
  // Entries disappear from this list the moment they turn terminal
  // (manager notifies + prunes), so cancel keeps working live.
  return (
    <>
      {activeUploads.length > 0 && (
        <div className="flex flex-col gap-2 mt-6">
          <SettingsSectionHeading title={t("settings.uploads_section")} />
          <div className="flex flex-col">
            {activeUploads.map((entry) => (
              <SettingsRow
                key={entry.id}
                leftClassName="flex items-center gap-4 min-w-0"
                textClassName="min-w-0"
                titleTruncate
                titleAttr={entry.name}
                icon={<CloudUpload className="w-6 h-6 text-brand-primary" />}
                title={truncatePathMiddle(entry.name)}
                subtitle={
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {uploadProgressLabel(entry)}
                  </p>
                }
              >
                <button
                  onClick={() => {
                    cancelUpload(entry.id);
                  }}
                  className="px-3 py-1.5 bg-brand-primary hover:bg-brand-hover text-white rounded-xl font-medium transition-all transform active:scale-95 shadow-sm border border-transparent flex items-center gap-2 whitespace-nowrap"
                >
                  {t("settings.uploads_cancel")}
                </button>
              </SettingsRow>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
