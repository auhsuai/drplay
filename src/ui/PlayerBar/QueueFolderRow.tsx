import { useTranslation } from "react-i18next";
import { AudioLines, Folder } from "lucide-react";
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

  const titleClass = `font-semibold text-[15px] transition-colors truncate leading-tight ${containsCurrent ? "text-brand-text!" : "text-gray-800 dark:text-gray-200"} group-hover:text-brand-text`;

  return (
    <div
      data-testid="queue-folder-row"
      role="gridcell"
      className="group relative w-full rounded-xl"
      style={{ height: QUEUE_ROW_HEIGHT }}
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- QR-2 parity: keyboard activation is owned by the QueueList listbox (aria-activedescendant + Enter/Space -> open); the card is not an independent control or tab stop. Mouse-only click here. */}
      <div
        aria-current={containsCurrent ? "true" : undefined}
        onClick={onOpen}
        className="p-3 rounded-xl transition-all duration-300 flex items-center gap-4 w-full cursor-pointer bg-[#F8F9FA] dark:bg-[#202124] hover:bg-gray-100 dark:hover:bg-[#2a2b2f] hover:shadow-md group-hover:-translate-y-1 active:scale-[0.98]"
      >
        <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0 bg-amber-100 dark:bg-amber-900/30 text-amber-500">
          <Folder className="w-6 h-6" fill="currentColor" />
        </div>

        <div
          className={`overflow-hidden flex-1 flex flex-col justify-center ${selectionMode ? "" : "mr-11"}`}
        >
          <h3 className={titleClass}>{folderName}</h3>
          <div className="flex items-center gap-2 mt-0.5 min-w-0">
            <span className="text-[11px] font-medium tracking-wide text-gray-500 dark:text-gray-400">
              {t("queue.folder_item_count", { count })}
            </span>
            {containsCurrent && (
              <AudioLines
                aria-hidden="true"
                className="w-3 h-3 shrink-0 text-brand-text"
              />
            )}
          </div>
        </div>
      </div>

      {!selectionMode && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <MoreMenu
            variant="queue"
            queueFolder={{ id: folderId, name: folderName }}
            onRemoveFolderFromQueue={onRemoveFolder}
          />
        </div>
      )}
    </div>
  );
}
