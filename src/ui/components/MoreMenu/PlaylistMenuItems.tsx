import { ListX, MapPin, SquareCheckBig } from "lucide-react";
import type { Track } from "../../../types";
import { MENU_ITEM_BASE_CLASS } from "./constants";
import { MoreMenuItem } from "./MoreMenuItem";

interface PlaylistMenuItemsProps {
  track?: Track | undefined;
  handleNavigateClick: (e: React.MouseEvent) => void;
  onSelectMultiple?: (() => void) | undefined;
  onRemoveFromPlaylist?: (() => void) | undefined;
  setIsOpen: (open: boolean) => void;
  onClose?: (() => void) | undefined;
  t: import("i18next").TFunction;
}

/**
 * Row menu for a playlist entry: selection, locate, and removal from the
 * playlist only. File-management actions (download/delete/move/queue) are
 * deliberately absent — a playlist is a reference list, not a Drive browser,
 * and removal must never touch the underlying file.
 */
export function PlaylistMenuItems({
  track,
  handleNavigateClick,
  onSelectMultiple,
  onRemoveFromPlaylist,
  setIsOpen,
  onClose,
  t,
}: PlaylistMenuItemsProps) {
  if (!track) return null;

  return (
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
        className={MENU_ITEM_BASE_CLASS}
      />

      <MoreMenuItem
        icon={MapPin}
        label={t("menu.navigate")}
        onClick={handleNavigateClick}
        className={MENU_ITEM_BASE_CLASS}
      />

      <MoreMenuItem
        icon={ListX}
        label={t("remove_from_playlist")}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(false);
          onClose?.();
          onRemoveFromPlaylist?.();
        }}
        className={MENU_ITEM_BASE_CLASS}
      />
    </>
  );
}
