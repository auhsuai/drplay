import { SquareCheckBig, Download, FolderOutput, Trash2 } from "lucide-react";
import type { Track } from "../../../types";
import type { DriveItem } from "../../../types";
import { menuItemBaseClass, menuItemDeleteClass } from "./constants";
import { IS_MOBILE } from "../../../utils/platform";
import { MoreMenuItem } from "./MoreMenuItem";

interface DefaultMenuItemsProps {
  track?: Track | undefined;
  driveItem?: DriveItem | undefined;
  token?: string | null | undefined;
  handleDownloadClick: (
    e: React.MouseEvent,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
  ) => void;
  openDeleteConfirm: (item: DriveItem) => void;
  uploadingBlocked: (extraClass: string) => string;
  isTargetUploading: boolean;
  uploadBlockedTitle: string | undefined;
  setIsOpen: (open: boolean) => void;
  onClose?: (() => void) | undefined;
  onSelectMultiple?: (() => void) | undefined;
  isBulkSelected?: boolean | undefined;
  onBulkMoveClick?: (() => void) | undefined;
  onBulkDeleteClick?: (() => void) | undefined;
  setShowMoveScreen: (value: boolean) => void;
  t: import("i18next").TFunction;
}

export function DefaultMenuItems({
  track,
  driveItem,
  token,
  handleDownloadClick,
  openDeleteConfirm,
  uploadingBlocked,
  isTargetUploading,
  uploadBlockedTitle,
  setIsOpen,
  onClose,
  onSelectMultiple,
  isBulkSelected,
  onBulkMoveClick,
  onBulkDeleteClick,
  setShowMoveScreen,
  t,
}: DefaultMenuItemsProps) {
  const baseClass = menuItemBaseClass(IS_MOBILE);
  const deleteClass = menuItemDeleteClass(IS_MOBILE);
  return (
    <>
      {driveItem && token && (
        <>
          <MoreMenuItem
            icon={SquareCheckBig}
            label={t("menu.select_multiple")}
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
              onClose?.();
              onSelectMultiple?.();
            }}
            className={uploadingBlocked(baseClass)}
            disabled={isTargetUploading}
            title={uploadBlockedTitle}
            iconClassName="w-4 h-4 text-gray-400 group-hover:text-brand-primary"
            truncateLabel={false}
          />
          <MoreMenuItem
            icon={FolderOutput}
            label={t("drive.move_to")}
            onClick={(e) => {
              e.stopPropagation();
              if (isBulkSelected && onBulkMoveClick) {
                setIsOpen(false);
                onClose?.();
                onBulkMoveClick();
              } else {
                setShowMoveScreen(true);
                setIsOpen(false);
                onClose?.();
              }
            }}
            className={uploadingBlocked(baseClass)}
            disabled={isTargetUploading}
            title={uploadBlockedTitle}
          />
          <MoreMenuItem
            icon={Trash2}
            label={t("drive.delete")}
            onClick={(e) => {
              e.stopPropagation();
              if (isBulkSelected && onBulkDeleteClick) {
                setIsOpen(false);
                onClose?.();
                onBulkDeleteClick();
              } else {
                openDeleteConfirm(driveItem);
                setIsOpen(false);
                onClose?.();
              }
            }}
            className={uploadingBlocked(deleteClass)}
            disabled={isTargetUploading}
            title={uploadBlockedTitle}
          />
        </>
      )}

      {track && (
        <MoreMenuItem
          icon={Download}
          label={t("menu.download")}
          onClick={(e) => {
            handleDownloadClick(e, track, setIsOpen);
          }}
          className={uploadingBlocked(
            `${baseClass} disabled:opacity-50 disabled:cursor-not-allowed`,
          )}
          disabled={isTargetUploading}
          title={uploadBlockedTitle}
        />
      )}
    </>
  );
}
