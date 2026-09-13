import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
import { MoreMenu } from "../components/MoreMenu";
import { QUEUE_ROW_HEIGHT } from "./QueueRow";

export interface QueueFolderRowProps {
  folderId: string;
  folderName: string;
  count: number;
  containsCurrent: boolean;
  selectionMode: boolean;
  onOpen: () => void;
  onRemoveFolder: () => void;
}

/**
 * One collapsed folder entry in the Play Queue: SongCard-cloned card (amber
 * 48px folder tile, 15px semibold title, song-count subtitle). Clicking opens
 * the drill-down view — it never starts playback. The row menu (always
 * visible, hidden in selection mode like the track rows) offers exactly two
 * folder actions: locate in MyDrive and remove the whole group.
 */
export function QueueFolderRow({
  folderId,
  folderName,
  count,
  containsCurrent,
  selectionMode,
  onOpen,
  onRemoveFolder,
}: QueueFolderRowProps) {
  const { t } = useTranslation();

  const titleClass = `font-semibold text-[15px] transition-colors truncate leading-tight ${containsCurrent ? "text-brand-primary!" : "text-gray-800 dark:text-gray-200"} group-hover:text-brand-primary`;

  return (
    <div
      data-testid="queue-folder-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Keys pressed on inner elements must not double-trigger the open.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group w-full rounded-xl cursor-pointer"
      style={{ height: QUEUE_ROW_HEIGHT }}
    >
      <div className="p-3 rounded-xl transition-all duration-300 flex items-center gap-4 w-full bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md group-hover:-translate-y-1 active:scale-[0.98]">
        <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 bg-amber-100 dark:bg-amber-900/30 text-amber-500">
          <Folder className="w-6 h-6" fill="currentColor" />
        </div>

        <div className="overflow-hidden flex-1 flex flex-col justify-center">
          <h3 className={titleClass}>{folderName}</h3>
          <div className="flex items-center gap-2 mt-0.5 min-w-0">
            <span className="text-[11px] font-medium tracking-wide text-gray-500 dark:text-gray-400">
              {t("queue.folder_item_count", { count })}
            </span>
          </div>
        </div>

        {!selectionMode && (
          <div className="ml-2 shrink-0">
            <MoreMenu
              variant="queue"
              queueFolder={{ id: folderId, name: folderName }}
              onRemoveFolderFromQueue={onRemoveFolder}
            />
          </div>
        )}
      </div>
    </div>
  );
}
