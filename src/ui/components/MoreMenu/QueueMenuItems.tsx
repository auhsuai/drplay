import { Download, FolderMinus, ListX, MapPin } from "lucide-react";
import type { Track } from "../../../types";
import { MENU_ITEM_BASE_CLASS } from "./constants";
import { MoreMenuItem } from "./MoreMenuItem";

interface QueueMenuItemsProps {
  track?: Track | undefined;
  queueFolder?: { id: string; name: string } | undefined;
  handleDownloadClick: (
    e: React.MouseEvent,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
  ) => void;
  handleNavigateClick: (e: React.MouseEvent) => void;
  onRemoveFromQueue?: (() => void) | undefined;
  disableRemoveFromQueue?: boolean | undefined;
  onRemoveFolderFromQueue?: (() => void) | undefined;
  setIsOpen: (open: boolean) => void;
  t: import("i18next").TFunction;
}

/**
 * Row menu for the play-queue panel: the player-bar entries (download /
 * locate) plus queue edits (remove entry / remove whole source folder).
 * File-management actions (move/delete) are deliberately absent — the queue
 * is a playback list, not a Drive browser.
 * A collapsed folder row (no track) gets its own smaller set: locate the
 * folder in MyDrive and remove the whole group from the queue.
 */
export function QueueMenuItems({
  track,
  queueFolder,
  handleDownloadClick,
  handleNavigateClick,
  onRemoveFromQueue,
  disableRemoveFromQueue,
  onRemoveFolderFromQueue,
  setIsOpen,
  t,
}: QueueMenuItemsProps) {
  if (!track && queueFolder) {
    return (
      <>
        <MoreMenuItem
          icon={MapPin}
          label={t("menu.navigate")}
          onClick={handleNavigateClick}
          className={MENU_ITEM_BASE_CLASS}
        />

        <MoreMenuItem
          icon={FolderMinus}
          label={t("queue.remove_folder")}
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen(false);
            onRemoveFolderFromQueue?.();
          }}
          className={MENU_ITEM_BASE_CLASS}
        />
      </>
    );
  }

  return (
    <>
      {track && (
        <>
          <MoreMenuItem
            icon={Download}
            label={t("menu.download_song")}
            onClick={(e) => {
              handleDownloadClick(e, track, setIsOpen);
            }}
            className={`${MENU_ITEM_BASE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
          />

          <MoreMenuItem
            icon={MapPin}
            label={t("menu.navigate")}
            onClick={handleNavigateClick}
            className={MENU_ITEM_BASE_CLASS}
          />

          <MoreMenuItem
            icon={ListX}
            label={t("queue.remove_from_queue")}
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
              onRemoveFromQueue?.();
            }}
            disabled={disableRemoveFromQueue ?? false}
            title={
              disableRemoveFromQueue
                ? t("queue.current_cannot_remove")
                : undefined
            }
            className={`${MENU_ITEM_BASE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
          />

          {onRemoveFolderFromQueue && (
            <MoreMenuItem
              icon={FolderMinus}
              label={t("queue.remove_folder")}
              onClick={(e) => {
                e.stopPropagation();
                setIsOpen(false);
                onRemoveFolderFromQueue();
              }}
              className={MENU_ITEM_BASE_CLASS}
            />
          )}
        </>
      )}
    </>
  );
}
