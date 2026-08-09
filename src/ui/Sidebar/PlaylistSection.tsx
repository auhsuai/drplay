import { useState, useEffect } from "react";
import type { SyntheticEvent } from "react";
import { Plus, ListMusic } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Playlist } from "../../utils/playlists";
import { getPlaylists, createPlaylist } from "../../utils/playlists";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import type { TabKey } from "../../utils/driveConstants";
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

  return (
    <>
      <div
        className={`px-4 mt-6 mb-2 flex items-center group transition-all duration-300 ${isSidebarOpen ? "justify-between" : ""}`}
      >
        <div
          className={`overflow-hidden transition-all duration-300 whitespace-nowrap ${isSidebarOpen ? "max-w-[160px] opacity-100 flex-1" : "max-w-0 opacity-0 flex-none"}`}
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
        {playlists.map((p) => (
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
          />
        ))}
      </div>
    </>
  );
}
