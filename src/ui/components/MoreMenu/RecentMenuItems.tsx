import { Download, MapPin, Trash2 } from "lucide-react";
import type { Track } from "../../../types";
import type { DriveItem } from "../../../types";
import { menuItemBaseClass, menuItemDeleteClass } from "./constants";
import { IS_MOBILE } from "../../../utils/platform";
import { MoreMenuItem } from "./MoreMenuItem";

interface RecentMenuItemsProps {
  track?: Track | undefined;
  driveItem?: DriveItem | undefined;
  token?: string | null | undefined;
  handleDownloadClick: (
    e: React.MouseEvent,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
  ) => void;
  handleNavigateClick: (e: React.MouseEvent) => void;
  openDeleteConfirm: (item: DriveItem) => void;
  uploadingBlocked: (extraClass: string) => string;
  isTargetUploading: boolean;
  uploadBlockedTitle: string | undefined;
  setIsOpen: (open: boolean) => void;
  onClose?: (() => void) | undefined;
  t: import("i18next").TFunction;
}

export function RecentMenuItems({
  track,
  driveItem,
  token,
  handleDownloadClick,
  handleNavigateClick,
  openDeleteConfirm,
  uploadingBlocked,
  isTargetUploading,
  uploadBlockedTitle,
  setIsOpen,
  onClose,
  t,
}: RecentMenuItemsProps) {
  const baseClass = menuItemBaseClass(IS_MOBILE);
  const deleteClass = menuItemDeleteClass(IS_MOBILE);
  return (
    <>
      {driveItem && token && (
        <MoreMenuItem
          icon={Trash2}
          label={t("drive.delete")}
          onClick={(e) => {
            e.stopPropagation();
            openDeleteConfirm(driveItem);
            setIsOpen(false);
            onClose?.();
          }}
          className={uploadingBlocked(deleteClass)}
          disabled={isTargetUploading}
          title={uploadBlockedTitle}
        />
      )}

      {track && (
        <>
          <MoreMenuItem
            icon={Download}
            label={t("menu.download_song")}
            onClick={(e) => {
              handleDownloadClick(e, track, setIsOpen);
            }}
            className={uploadingBlocked(
              `${baseClass} disabled:opacity-50 disabled:cursor-not-allowed`,
            )}
            disabled={isTargetUploading}
            title={uploadBlockedTitle}
          />

          <MoreMenuItem
            icon={MapPin}
            label={t("menu.navigate")}
            onClick={handleNavigateClick}
            className={baseClass}
          />
        </>
      )}
    </>
  );
}
