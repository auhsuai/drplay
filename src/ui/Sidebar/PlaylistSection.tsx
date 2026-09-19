import { useState, useEffect, useRef } from "react";
import type { SyntheticEvent } from "react";
import { Plus, ListMusic } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Playlist } from "../../utils/playlists";
import {
  getPlaylists,
  createPlaylist,
  deletePlaylist,
  updatePlaylist,
} from "../../utils/playlists";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { TABS } from "../../utils/driveConstants";
import type { TabKey } from "../../utils/driveConstants";
import { MoreMenu } from "../components/MoreMenu";
import { SIDEBAR_MODULE } from "./constants";
import { NavItem } from "./NavItem";

interface PlaylistSectionProps {
  onTabChange: (tab: TabKey) => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  activeTab: TabKey;
}

export function PlaylistSection({
  onTabChange,
  isSidebarOpen,
  onToggleSidebar,
  activeTab,
}: PlaylistSectionProps) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  // Right-click anchor for the playlist menu. One entry for the whole list:
  // only one playlist menu can be open, so two rows can never stack menus.
  const [contextMenu, setContextMenu] = useState<{
    playlistId: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getPlaylists()
      .then((data) => {
        if (!cancelled) setPlaylists(data);
      })
      .catch(
        (err: unknown) =>
          void captureError({
            level: "error",
            source: SIDEBAR_MODULE,
            message: `failed-to-load-playlists: ${err instanceof Error ? err.message : String(err)}`,
          }),
      );
    const handleUpdate = () => {
      void getPlaylists()
        .then((data) => {
          if (!cancelled) setPlaylists(data);
        })
        .catch((err: unknown) => {
          void captureError({
            level: "error",
            source: SIDEBAR_MODULE,
            message: `failed-to-load-playlists: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    };
    window.addEventListener("playlists-updated", handleUpdate);
    window.addEventListener("user-changed", handleUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener("playlists-updated", handleUpdate);
      window.removeEventListener("user-changed", handleUpdate);
    };
  }, []);

  // A collapsed sidebar has no room for the rename field; abandon the edit
  // instead of leaving a stale input mounted outside the expand animation.
  // Adjusting state during render is the sanctioned alternative to a reset
  // effect (react.dev — "Adjusting some state when a prop changes").
  const [prevIsSidebarOpen, setPrevIsSidebarOpen] = useState(isSidebarOpen);
  if (isSidebarOpen !== prevIsSidebarOpen) {
    setPrevIsSidebarOpen(isSidebarOpen);
    if (!isSidebarOpen) setRenamingId(null);
  }

  // Focus + select once per rename target — keyed by id only, so typing in
  // the field is never re-selected mid-edit.
  useEffect(() => {
    if (renamingId === null) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  const handleCreate = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!newPlaylistName.trim()) {
      setIsCreating(false);
      return;
    }
    try {
      const newPlaylist = await createPlaylist(newPlaylistName.trim());
      if (newPlaylist) {
        onTabChange(`playlist_${newPlaylist.id}`);
      }
    } catch (err) {
      void captureError({
        level: "error",
        source: SIDEBAR_MODULE,
        message: `create-playlist-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("sidebar.create_playlist_error"));
    } finally {
      setNewPlaylistName("");
      setIsCreating(false);
    }
  };

  // Deleting a playlist only removes the playlist row — never the underlying
  // files (deletePlaylist touches db.playlists only). Same confirmation copy
  // as the playlist header delete, and the same redirect when the open
  // playlist disappears.
  const handleDeletePlaylist = async (playlist: Playlist) => {
    if (!window.confirm(t("confirm_delete_playlist"))) return;
    try {
      await deletePlaylist(playlist.id);
      if (activeTab === `playlist_${playlist.id}`) onTabChange(TABS.home);
    } catch (err) {
      void captureError({
        level: "error",
        source: SIDEBAR_MODULE,
        message: `delete-playlist-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("playlist.delete_error"));
    }
  };

  const handleTogglePin = async (playlist: Playlist) => {
    try {
      await updatePlaylist(playlist.id, {
        pinned: !(playlist.pinned ?? false),
      });
    } catch (err) {
      void captureError({
        level: "error",
        source: SIDEBAR_MODULE,
        message: `pin-playlist-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("playlist.update_error"));
    }
  };

  const commitRename = async (playlist: Playlist) => {
    const name = renamingId === playlist.id ? renameName.trim() : "";
    setRenamingId(null);
    // Empty or unchanged names are a cancel, never a write.
    if (!name || name === playlist.name) return;
    try {
      // updatePlaylist replaces the row in place — renaming can never create
      // a second playlist; the playlists-updated event refreshes the sidebar.
      await updatePlaylist(playlist.id, { name });
    } catch (err) {
      void captureError({
        level: "error",
        source: SIDEBAR_MODULE,
        message: `rename-playlist-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("playlist.update_error"));
    }
  };

  // Pinned playlists first. Array.prototype.sort is stable (ES2019), so the
  // relative order inside the pinned and unpinned groups is preserved.
  const orderedPlaylists = [...playlists].sort(
    (a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false),
  );

  return (
    <>
      <div className="px-4 mt-6 mb-2 flex items-center group transition-all duration-300">
        <div
          className={`overflow-hidden transition-all duration-300 whitespace-nowrap flex-1 ${isSidebarOpen ? "max-w-full opacity-100" : "max-w-0 opacity-0"}`}
        >
          <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            {t("sidebar.playlists")}
          </h2>
        </div>
        <button
          onClick={() => {
            if (!isSidebarOpen) onToggleSidebar();
            setIsCreating(true);
          }}
          className={`text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-all duration-300 w-6 h-6 flex items-center justify-center shrink-0 ${isSidebarOpen ? "" : "ml-3"}`}
          title={t("sidebar.create_playlist")}
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 px-4 overflow-y-auto space-y-1 pb-4 custom-scrollbar overflow-x-hidden">
        <div
          className={`overflow-hidden transition-all duration-300 ${isCreating && isSidebarOpen ? "max-h-20 opacity-100 mb-2" : "max-h-0 opacity-0 m-0"}`}
        >
          <form
            onSubmit={(e) => {
              void handleCreate(e);
            }}
          >
            <input
              type="text"
              value={newPlaylistName}
              onChange={(e) => {
                setNewPlaylistName(e.target.value);
              }}
              onBlur={() => {
                if (!newPlaylistName) setIsCreating(false);
              }}
              className="w-full bg-gray-200/50 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-gray-200 dark:focus:bg-[#25262a] text-gray-900 dark:text-white text-sm rounded-lg px-3 py-2 outline-none transition-all duration-300 placeholder:text-gray-500"
              placeholder={t("sidebar.new_playlist_placeholder")}
            />
          </form>
        </div>
        {orderedPlaylists.map((p) =>
          renamingId === p.id ? (
            <form
              key={p.id}
              onSubmit={(e) => {
                e.preventDefault();
                void commitRename(p);
              }}
            >
              <input
                ref={renameInputRef}
                type="text"
                value={renameName}
                onChange={(e) => {
                  setRenameName(e.target.value);
                }}
                onBlur={() => {
                  void commitRename(p);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setRenamingId(null);
                  }
                }}
                aria-label={t("rename")}
                spellCheck={false}
                className="w-full bg-gray-200/50 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-gray-200 dark:focus:bg-[#25262a] text-gray-900 dark:text-white text-sm rounded-lg px-3 py-2 outline-none transition-all duration-300 placeholder:text-gray-500"
              />
            </form>
          ) : (
            <NavItem
              key={p.id}
              icon={
                p.coverImage ? (
                  <img
                    src={p.coverImage}
                    alt={p.name}
                    className="w-5 h-5 rounded object-cover"
                  />
                ) : (
                  <ListMusic />
                )
              }
              label={p.name}
              active={activeTab === `playlist_${p.id}`}
              onClick={() => {
                onTabChange(`playlist_${p.id}`);
              }}
              isSidebarOpen={isSidebarOpen}
              onContextMenu={(e) => {
                e.preventDefault();
                // Menu is an expanded-sidebar affordance only.
                if (!isSidebarOpen) return;
                setContextMenu({
                  playlistId: p.id,
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
              action={
                isSidebarOpen ? (
                  <div
                    className={`ml-1 shrink-0 transition-opacity ${contextMenu?.playlistId === p.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
                  >
                    <MoreMenu
                      variant="sidebarPlaylist"
                      playlist={p}
                      forceOpen={contextMenu?.playlistId === p.id}
                      anchorPoint={
                        contextMenu?.playlistId === p.id
                          ? { x: contextMenu.x, y: contextMenu.y }
                          : null
                      }
                      onClose={() => {
                        setContextMenu(null);
                      }}
                      onOpenChange={(open) => {
                        // Trigger click while a right-click menu is open:
                        // drop the stale anchor so the menu re-anchors to the
                        // button and the next trigger click closes it.
                        if (open) setContextMenu(null);
                      }}
                      onRenamePlaylist={() => {
                        setRenamingId(p.id);
                        setRenameName(p.name);
                      }}
                      onDeletePlaylist={() => {
                        void handleDeletePlaylist(p);
                      }}
                      onTogglePinPlaylist={() => {
                        void handleTogglePin(p);
                      }}
                    />
                  </div>
                ) : undefined
              }
            />
          ),
        )}
      </div>
    </>
  );
}
