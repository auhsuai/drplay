import React, { useState, useEffect } from "react";
import { Home, HardDrive, Settings, Heart, Plus, ListMusic, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getPlaylists, createPlaylist, Playlist } from "../../utils/playlists";
import { showErrorToast } from "../../utils/simpleToast";

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  userProfile?: { name: string; email: string; picture: string } | null;
  onLogout?: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function Sidebar({ activeTab, onTabChange, onLogout, userProfile, isSidebarOpen, onToggleSidebar }: SidebarProps) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");

  useEffect(() => {
    let cancelled = false;
    getPlaylists().then(data => { if (!cancelled) setPlaylists(data); }).catch(err => console.error('[Sidebar] Failed to load playlists', err));
    const handleUpdate = () => getPlaylists().then(data => { if (!cancelled) setPlaylists(data); }).catch(err => console.error('[Sidebar] Failed to load playlists', err));
    window.addEventListener('playlists-updated', handleUpdate);
    window.addEventListener('user-changed', handleUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('playlists-updated', handleUpdate);
      window.removeEventListener('user-changed', handleUpdate);
    };
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
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
      console.error("[Sidebar] create-playlist: Failed to create playlist", err);
      showErrorToast(t('sidebar.create_playlist_error') || "Failed to create playlist");
    } finally {
      setNewPlaylistName("");
      setIsCreating(false);
    }
  };

  return (
    <aside className={`${isSidebarOpen ? 'w-64' : 'w-20'} bg-[#F8F9FA] dark:bg-[#121212] h-full flex flex-col shrink-0 transition-all duration-300 overflow-hidden border-r border-gray-200/50 dark:border-gray-800/50`}>
      <div className="px-7 py-6 flex items-center cursor-pointer transition-all duration-300" onClick={onToggleSidebar}>
        <h1 className="text-xl font-bold flex items-center text-[#4285F4]" title="DrPlay">
          <HardDrive className="w-6 h-6 shrink-0" />
          <div className={`overflow-hidden transition-all duration-300 whitespace-nowrap flex items-center ${isSidebarOpen ? 'max-w-[100px] opacity-100 ml-2' : 'max-w-0 opacity-0 ml-0'}`}>
            <span className="truncate">DrPlay</span>
          </div>
        </h1>
      </div>
      <nav className="px-4 space-y-1 mb-2">
        <NavItem icon={<Home />} label={t('sidebar.home')} active={activeTab === "Home"} onClick={() => onTabChange("Home")} isSidebarOpen={isSidebarOpen} />
        <NavItem icon={<HardDrive />} label={t('sidebar.my_drive')} active={activeTab === "My Drive"} onClick={() => onTabChange("My Drive")} isSidebarOpen={isSidebarOpen} />
        <NavItem icon={<Heart />} label={t('sidebar.liked_songs')} active={activeTab === "Liked Songs"} onClick={() => onTabChange("Liked Songs")} isSidebarOpen={isSidebarOpen} />
      </nav>
      
      <div className="px-4 mt-6 mb-2 flex items-center group transition-all duration-300">
        <div className={`overflow-hidden transition-all duration-300 whitespace-nowrap ${isSidebarOpen ? 'max-w-[160px] opacity-100 flex-1' : 'max-w-0 opacity-0 flex-none'}`}>
          <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('sidebar.playlists')}</h2>
        </div>
        <button 
          onClick={() => {
            if (!isSidebarOpen) onToggleSidebar();
            setIsCreating(true);
          }}
          className={`text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-all duration-300 w-6 h-6 flex items-center justify-center shrink-0 ${isSidebarOpen ? '' : 'ml-3'}`}
          title={t('sidebar.create_playlist')}
        >
          <Plus className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 px-4 overflow-y-auto space-y-1 pb-4 custom-scrollbar overflow-x-hidden">
        <div className={`overflow-hidden transition-all duration-300 ${isCreating && isSidebarOpen ? 'max-h-20 opacity-100 mb-2' : 'max-h-0 opacity-0 m-0'}`}>
          <form onSubmit={handleCreate}>
            <input 
              type="text" 
              autoFocus
              value={newPlaylistName}
              onChange={e => setNewPlaylistName(e.target.value)}
              onBlur={() => !newPlaylistName && setIsCreating(false)}
              className="w-full bg-gray-200/50 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-gray-200 dark:focus:bg-[#25262a] text-gray-900 dark:text-white text-sm rounded-lg px-3 py-2 outline-none transition-all duration-300 placeholder:text-gray-500"
              placeholder={t('sidebar.new_playlist_placeholder') || "My Playlist #1"}
            />
          </form>
        </div>
        {playlists.map(p => (
          <NavItem 
            key={p.id}
            icon={p.coverImage ? <img src={p.coverImage} alt={p.name} className="w-5 h-5 rounded object-cover" /> : <ListMusic />} 
            label={p.name} 
            active={activeTab === `playlist_${p.id}`} 
            onClick={() => onTabChange(`playlist_${p.id}`)}
            isSidebarOpen={isSidebarOpen}
          />
        ))}
      </div>

      <div className="p-4">
        <NavItem icon={<Settings />} label={t('sidebar.settings')} active={activeTab === "Settings"} onClick={() => onTabChange("Settings")} isSidebarOpen={isSidebarOpen} />
        
        <div className="mt-4 pt-4 flex items-center transition-all duration-300">
          <div className="ml-1 shrink-0 flex items-center justify-center">
            {userProfile ? (
              <img 
                src={userProfile.picture} 
                alt="Profile" 
                referrerPolicy="no-referrer"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  if (e.currentTarget.nextElementSibling) {
                    (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex';
                  }
                }}
                className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 object-cover" 
              />
            ) : null}
            
            {(!userProfile) ? (
              <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                <span className="text-gray-400 font-bold">?</span>
              </div>
            ) : (
              <div className="w-10 h-10 rounded-full bg-[#4285F4]/20 hidden items-center justify-center">
                <span className="text-[#4285F4] font-bold">{userProfile.name.charAt(0).toUpperCase()}</span>
              </div>
            )}
          </div>
          
          <div className={`overflow-hidden transition-all duration-300 whitespace-nowrap flex flex-col justify-center ${isSidebarOpen ? 'max-w-[150px] opacity-100 ml-3' : 'max-w-0 opacity-0 ml-0'}`}>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
              {userProfile ? userProfile.name : t('sidebar.guest')}
            </p>
            <p className="text-xs text-gray-500 truncate" title={userProfile?.email || ""}>
              {userProfile ? userProfile.email : t('sidebar.not_authenticated')}
            </p>
          </div>
          
          {onLogout && (
            <div className={`overflow-hidden transition-all duration-300 flex items-center ${isSidebarOpen ? 'max-w-[40px] opacity-100 ml-auto' : 'max-w-0 opacity-0'}`}>
              <button 
                onClick={onLogout}
                className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors shrink-0"
                title={t('sidebar.log_out')}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function NavItem({ icon, label, active, onClick, isSidebarOpen }: { icon: React.ReactNode, label: string, active?: boolean, onClick: () => void, isSidebarOpen: boolean }) {
  return (
    <div 
      onClick={onClick}
      title={!isSidebarOpen ? label : undefined}
      className={`flex items-center px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 active:scale-[0.98] font-medium ${
        active 
          ? 'bg-[#4285F4]/10 text-[#4285F4] shadow-sm' 
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white'
      }`}
    >
      <div className={`w-6 h-6 flex items-center justify-center shrink-0 ${active ? 'text-[#4285F4]' : 'opacity-70'}`}>
        {icon}
      </div>
      <div className={`overflow-hidden transition-all duration-300 whitespace-nowrap ${isSidebarOpen ? 'max-w-[150px] opacity-100 ml-3 flex-1' : 'max-w-0 opacity-0 ml-0'}`}>
        <span className="text-sm block truncate">{label}</span>
      </div>
    </div>
  );
}
