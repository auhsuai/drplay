import { Download, Heart, MapPin } from "lucide-react";
import type { Track } from "../../../types";
import { menuItemBaseClass } from "./constants";
import { IS_MOBILE } from "../../../utils/platform";
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
  /** Redesign 2026-08-17: mobile favorite toggle. Only rendered when BOTH
   *  are provided (TrackInfo mobile passes them; desktop does not). */
  isFavorite?: boolean | undefined;
  onToggleFavorite?: (() => void) | undefined;
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
  isFavorite,
  onToggleFavorite,
}: PlayerBarMenuItemsProps) {
  const baseClass = menuItemBaseClass(IS_MOBILE);
  return (
    <>
      {track && (
        <>
          {typeof isFavorite === "boolean" &&
            typeof onToggleFavorite === "function" && (
              <MoreMenuItem
                icon={Heart}
                label={
                  isFavorite
                    ? t("player.remove_favorite")
                    : t("player.add_favorite")
                }
                onClick={() => {
                  onToggleFavorite();
                  setIsOpen(false);
                }}
                className={baseClass}
              />
            )}

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
