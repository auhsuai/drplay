import { Download, MapPin } from "lucide-react";
import type { Track } from "../../../types";
import { MENU_ITEM_BASE_CLASS } from "./constants";
import { MoreMenuItem } from "./MoreMenuItem";

interface PlayerBarMenuItemsProps {
  track?: Track | undefined;
  handleDownloadClick: (
    e: React.MouseEvent,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
  ) => void;
  handleNavigateClick: (e: React.MouseEvent) => void;
  uploadingBlocked: (extraClass: string) => string;
  isTargetUploading: boolean;
  uploadBlockedTitle: string | undefined;
  setIsOpen: (open: boolean) => void;
  t: import("i18next").TFunction;
}

export function PlayerBarMenuItems({
  track,
  handleDownloadClick,
  handleNavigateClick,
  uploadingBlocked,
  isTargetUploading,
  uploadBlockedTitle,
  setIsOpen,
  t,
}: PlayerBarMenuItemsProps) {
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
            className={uploadingBlocked(
              `${MENU_ITEM_BASE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`,
            )}
            disabled={isTargetUploading}
            title={uploadBlockedTitle}
          />

          <MoreMenuItem
            icon={MapPin}
            label={t("menu.navigate")}
            onClick={handleNavigateClick}
            className={MENU_ITEM_BASE_CLASS}
          />
        </>
      )}
    </>
  );
}
