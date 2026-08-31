import { useEffect, useRef, useState } from "react";
import {
  Check,
  Ellipsis,
  Music,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  createPlaylist,
  deletePlaylist,
  getPlaylists,
  updatePlaylist,
  type Playlist,
} from "../../../utils/playlists";
import type { Track } from "../../../types";
import { showErrorToast } from "../../../utils/simpleToast";
import { useHardwareBack } from "../../../hooks/useHardwareBack";
import { IS_MOBILE } from "../../../utils/platform";
import { ModalShell } from "../ModalShell";
import { filterPlaylists } from "./PlaylistsSubmenu";
import { menuItemBaseClass, menuItemIconClass } from "./constants";

// Same forbidden-character set as Windows file names: playlist names are
// user-facing labels but must stay portable across Drive/OS surfaces.
const PLAYLIST_NAME_INVALID_RE = /[\\/:*?"<>|]/;

// Returns the trimmed name, or null when empty / carrying illegal characters.
function normalizePlaylistName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || PLAYLIST_NAME_INVALID_RE.test(trimmed)) return null;
  return trimmed;
}

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

  // Why local state: the prop comes from useMenuPlaylists, whose fetch is
  // bound to the (already closed) menu's lifecycle â€” after a create/rename/
  // delete the prop would stay stale. The modal therefore owns its data:
  // re-fetch on every open and after every successful mutation. The prop is
  // only the initial fallback before the first fetch resolves.
  const [localPlaylists, setLocalPlaylists] = useState<Playlist[]>(playlists);

  // Inline management state. Single-row invariants: at most one row shows an
  // action panel, a rename input or a delete confirm at a time; the create
  // row replaces the "new playlist" row at the top of the list.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [actionRowId, setActionRowId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Why ref-focus instead of autoFocus: the repo lint bans autoFocus
  // (jsx-a11y/no-autofocus) and the DownloadDialog pattern (ref + effect on
  // open) is the established alternative. Focus must land in the inline
  // input as soon as its row appears, without stealing it back afterwards.
  const createInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);
  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.focus();
  }, [renamingId]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Fresh search + data on every open (same reset-on-close state pattern as
  // useMenuPlaylists): a stale query must not filter the next open, and the
  // list must reflect mutations made while the modal was closed.
  const [prevOpen, setPrevOpen] = useState(open);
  if (!open && prevOpen !== open) {
    setPrevOpen(open);
    setQuery("");
    setCreating(false);
    setNewName("");
    setActionRowId(null);
    setRenamingId(null);
    setDeletingId(null);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getPlaylists().then((fresh) => {
      if (!cancelled) setLocalPlaylists(fresh);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Refresh = the modal's single source of truth after any mutation. The
  // util functions already surface their own failure toasts, so a rejection
  // here cannot happen for known error paths; guard against unexpected ones
  // without breaking the UI state.
  const refresh = () => {
    void getPlaylists().then((fresh) => {
      setLocalPlaylists(fresh);
    });
  };

  // Hardware back (mobile): the main menu is already closed by the time this
  // picker opens, so closing the picker never clashes with the menu's own
  // back handler (no double-peel). Returns true so the press is consumed
  // instead of falling through to the folder-up chain.
  useHardwareBack(() => {
    onClose();
    return true;
  }, open);

  if (!open) return null;

  const filtered = filterPlaylists(localPlaylists, query);

  const closeCreateRow = () => {
    setCreating(false);
    setNewName("");
  };

  const confirmCreate = () => {
    const name = normalizePlaylistName(newName);
    if (name === null) {
      // Invalid input never reaches the API; the shared toast explains why.
      showErrorToast(t("drive.folder_name_invalid"));
      return;
    }
    void createPlaylist(name).then(() => {
      closeCreateRow();
      refresh();
    });
  };

  const closeRenameRow = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const confirmRename = () => {
    if (renamingId === null) return;
    const name = normalizePlaylistName(renameValue);
    if (name === null) {
      showErrorToast(t("drive.folder_name_invalid"));
      return;
    }
    const id = renamingId;
    void updatePlaylist(id, { name }).then(() => {
      closeRenameRow();
      refresh();
    });
  };

  const confirmDelete = () => {
    if (deletingId === null) return;
    const id = deletingId;
    void deletePlaylist(id).then(() => {
      setDeletingId(null);
      refresh();
    });
  };

  const nameInputClass =
    "flex-1 min-w-0 bg-gray-100 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-gray-200 dark:focus:bg-[#25262a] text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-1.5 outline-none transition-all";

  return (
    <ModalShell
      labelledById="playlist-picker-title"
      onClose={onClose}
      initialFocusRef={searchRef}
    >
      <div className="flex items-center justify-between gap-2">
        <h3
          id="playlist-picker-title"
          className="text-lg font-bold text-gray-900 dark:text-white"
        >
          {t("menu.add_to_playlist")}
        </h3>
        <button
          aria-label={t("settings.close")}
          onClick={onClose}
          className="shrink-0 p-1.5 rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-[#2e2f34] dark:hover:text-white transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

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
        {creating ? (
          <div className="flex items-center gap-1 px-0.5 py-1">
            <input
              ref={createInputRef}
              type="text"
              placeholder={t("sidebar.new_playlist_placeholder")}
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmCreate();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeCreateRow();
                }
              }}
              className={nameInputClass}
            />
            <button
              aria-label={t("menu.save")}
              onClick={confirmCreate}
              className="shrink-0 p-1.5 rounded-md text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors cursor-pointer"
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              aria-label={t("common.cancel")}
              onClick={closeCreateRow}
              className="shrink-0 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-[#2e2f34] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setCreating(true);
            }}
            className="w-full text-left px-2.5 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-brand-primary rounded-md transition-all flex items-center gap-2 group mb-0.5 cursor-pointer"
          >
            <Plus className={menuItemIconClass(IS_MOBILE)} />
            <span className="truncate">{t("sidebar.create_playlist")}</span>
          </button>
        )}

        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-sm text-gray-400 text-center italic">
            {t("menu.no_playlists")}
          </div>
        ) : (
          filtered.map((p) => {
            if (actionRowId === p.id) {
              // Inline action panel REPLACES the row (no nested popup): the
              // row's own space is reused, so nothing stacks over the list.
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-0.5 rounded-md bg-gray-50 dark:bg-[#25262a] px-1 py-0.5"
                >
                  <button
                    aria-label={t("playlist.rename")}
                    onClick={() => {
                      // Leave the panel: the rename input REPLACES the row.
                      setActionRowId(null);
                      setRenamingId(p.id);
                      setRenameValue(p.name);
                    }}
                    className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-[#33343a] rounded-md transition-all cursor-pointer"
                  >
                    <Pencil className={menuItemIconClass(IS_MOBILE)} />
                    <span className="truncate">{t("playlist.rename")}</span>
                  </button>
                  <button
                    aria-label={t("common.delete")}
                    onClick={() => {
                      // Leave the panel: the delete confirm REPLACES the row.
                      setActionRowId(null);
                      setDeletingId(p.id);
                    }}
                    className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all cursor-pointer"
                  >
                    <Trash2 className={menuItemIconClass(IS_MOBILE)} />
                    <span className="truncate">{t("common.delete")}</span>
                  </button>
                  <button
                    aria-label={t("common.cancel")}
                    onClick={() => {
                      setActionRowId(null);
                    }}
                    className="shrink-0 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-[#33343a] transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            }
            if (renamingId === p.id) {
              return (
                <div key={p.id} className="flex items-center gap-1 px-0.5 py-1">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={(e) => {
                      setRenameValue(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        confirmRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        closeRenameRow();
                      }
                    }}
                    className={nameInputClass}
                  />
                  <button
                    aria-label={t("menu.save")}
                    onClick={confirmRename}
                    className="shrink-0 p-1.5 rounded-md text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors cursor-pointer"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    aria-label={t("common.cancel")}
                    onClick={closeRenameRow}
                    className="shrink-0 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-[#2e2f34] transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            }
            if (deletingId === p.id) {
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-1 rounded-md bg-gray-50 dark:bg-[#25262a] px-1.5 py-1"
                >
                  <span className="flex-1 min-w-0 truncate text-sm text-gray-700 dark:text-gray-200">
                    {t("confirm_delete_playlist")}
                  </span>
                  <button
                    aria-label={t("common.delete")}
                    onClick={confirmDelete}
                    className="shrink-0 flex items-center gap-1 px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all cursor-pointer"
                  >
                    <Trash2 className={menuItemIconClass(IS_MOBILE)} />
                    {t("common.delete")}
                  </button>
                  <button
                    aria-label={t("common.cancel")}
                    onClick={() => {
                      setDeletingId(null);
                    }}
                    className="shrink-0 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-[#33343a] transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            }
            // Row = pick button (unchanged contract) + kebab for management.
            // The kebab is a SIBLING of the pick button (never nested inside
            // it) so the row stays valid interactive markup.
            return (
              <div key={p.id} className="flex items-center gap-0.5">
                <button
                  onClick={(e) => {
                    onPick(e, p.id);
                  }}
                  className={`${menuItemBaseClass(IS_MOBILE)} flex-1 min-w-0`}
                >
                  <Music className={menuItemIconClass(IS_MOBILE)} />
                  <span className="truncate">{p.name}</span>
                </button>
                <button
                  aria-label={t("playlist.row_actions")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActionRowId(p.id);
                  }}
                  className="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-[#33343a] transition-colors cursor-pointer"
                >
                  <Ellipsis className="w-4 h-4" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </ModalShell>
  );
}
