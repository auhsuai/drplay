import { Download, MapPin } from "lucide-react";
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
  setIsOpen: (open: boolean) => void;
  t: import("i18next").TFunction;
}

export function PlayerBarMenuItems({
  track,
  handleDownloadClick,
  handleNavigateClick,
  setIsOpen,
  t,
}: PlayerBarMenuItemsProps) {
  const baseClass = menuItemBaseClass(IS_MOBILE);
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
            className={baseClass}
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
