import { Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { Playlist } from "../../../utils/playlists";
import { MENU_ITEM_BASE_CLASS, MENU_ITEM_DELETE_CLASS } from "./constants";
import { MoreMenuItem } from "./MoreMenuItem";

interface SidebarPlaylistMenuItemsProps {
  playlist?: Playlist | undefined;
  onRename?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  onTogglePin?: (() => void) | undefined;
  setIsOpen: (open: boolean) => void;
  onClose?: (() => void) | undefined;
  t: import("i18next").TFunction;
}

/**
 * Menu for a playlist in the sidebar: manages the playlist itself
 * (delete / rename / pin), never the tracks inside it. Delete removes the
 * playlist row only — file-deletion handlers are deliberately not reachable
 * from this menu.
 */
export function SidebarPlaylistMenuItems({
  playlist,
  onRename,
  onDelete,
  onTogglePin,
  setIsOpen,
  onClose,
  t,
}: SidebarPlaylistMenuItemsProps) {
  if (!playlist) return null;

  const run = (action?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    onClose?.();
    action?.();
  };

  return (
    <>
      <MoreMenuItem
        icon={Trash2}
        label={t("delete")}
        onClick={run(onDelete)}
        className={MENU_ITEM_DELETE_CLASS}
      />

      <MoreMenuItem
        icon={Pencil}
        label={t("rename")}
        onClick={run(onRename)}
        className={MENU_ITEM_BASE_CLASS}
      />

      <MoreMenuItem
        icon={playlist.pinned ? PinOff : Pin}
        label={playlist.pinned ? t("unpin_from_top") : t("pin_to_top")}
        onClick={run(onTogglePin)}
        className={MENU_ITEM_BASE_CLASS}
      />
    </>
  );
}
