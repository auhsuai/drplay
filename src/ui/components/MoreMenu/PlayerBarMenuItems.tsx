import { Download, List, MapPin } from "lucide-react";
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
  setIsOpen: (open: boolean) => void;
  t: import("i18next").TFunction;
  isQueueOpen?: boolean | undefined;
  onToggleQueue?: (() => void) | undefined;
}

export function PlayerBarMenuItems({
  track,
  handleDownloadClick,
  handleNavigateClick,
  setIsOpen,
  t,
  isQueueOpen,
  onToggleQueue,
}: PlayerBarMenuItemsProps) {
  return (
    <>
      {onToggleQueue && (
        <MoreMenuItem
          icon={List}
          label={t("queue.open")}
          checked={isQueueOpen}
          onClick={() => {
            onToggleQueue();
            setIsOpen(false);
          }}
          className={MENU_ITEM_BASE_CLASS}
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
            className={MENU_ITEM_BASE_CLASS}
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
