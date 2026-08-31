import { useRef, useState } from "react";
import { Music, Search } from "lucide-react";
import type { Playlist } from "../../../utils/playlists";
import type { Track } from "../../../types";
import { useHardwareBack } from "../../../hooks/useHardwareBack";
import { IS_MOBILE } from "../../../utils/platform";
import { ModalShell } from "../ModalShell";
import { filterPlaylists } from "./PlaylistsSubmenu";
import { menuItemBaseClass, menuItemIconClass } from "./constants";

interface PlaylistPickerModalProps {
  open: boolean;
  playlists: Playlist[];
  // Kept in the API for call-site symmetry with onPick's handler (which owns
  // the track); the modal itself only lists playlists.
  track: Track | undefined;
  onClose: () => void;
  onPick: (e: React.MouseEvent, playlistId: string) => void;
  t: import("i18next").TFunction;
}

export function PlaylistPickerModal({
  open,
  playlists,
  onClose,
  onPick,
  t,
}: PlaylistPickerModalProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  // Fresh search on every open (same reset-on-close state pattern as
  // useMenuPlaylists): a stale query must not filter the next open.
  const [prevOpen, setPrevOpen] = useState(open);
  if (!open && prevOpen !== open) {
    setPrevOpen(open);
    setQuery("");
  }

  // Hardware back (mobile): the main menu is already closed by the time this
  // picker opens, so closing the picker never clashes with the menu's own
  // back handler (no double-peel). Returns true so the press is consumed
  // instead of falling through to the folder-up chain.
  useHardwareBack(() => {
    onClose();
    return true;
  }, open);

  if (!open) return null;

  const filtered = filterPlaylists(playlists, query);

  return (
    <ModalShell
      labelledById="playlist-picker-title"
      onClose={onClose}
      initialFocusRef={searchRef}
    >
      <h3
        id="playlist-picker-title"
        className="text-lg font-bold text-gray-900 dark:text-white"
      >
        {t("menu.add_to_playlist")}
      </h3>

      <div className="relative">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          ref={searchRef}
          type="text"
          placeholder={t("search_placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          className="w-full bg-gray-100 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-gray-200 dark:focus:bg-[#25262a] text-gray-900 dark:text-gray-100 text-sm rounded-xl px-4 pl-9 py-2.5 outline-none transition-all placeholder:text-gray-500"
        />
      </div>

      <div className="max-h-[50vh] overflow-y-auto flex flex-col gap-0.5">
        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-sm text-gray-400 text-center italic">
            {t("menu.no_playlists")}
          </div>
        ) : (
          filtered.map((p) => (
            <button
              key={p.id}
              onClick={(e) => {
                onPick(e, p.id);
              }}
              className={menuItemBaseClass(IS_MOBILE)}
            >
              <Music className={menuItemIconClass(IS_MOBILE)} />
              <span className="truncate">{p.name}</span>
            </button>
          ))
        )}
      </div>
    </ModalShell>
  );
}
