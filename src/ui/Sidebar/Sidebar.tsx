import React, { useState, useEffect } from "react";
import { Home, HardDrive, Settings, Heart, Plus, ListMusic, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getPlaylists, createPlaylist, Playlist } from "../../utils/playlists";
import { getDriveStorageQuota, type DriveStorageQuota } from "../../utils/driveApi";
import { formatBytes } from "../../utils/formatBytes";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { TABS, type TabKey } from "../../utils/driveConstants";
import { UploadButton } from "../components/UploadButton";
import { DropZone } from "../components/DropZone";

const SIDEBAR_MODULE = 'Sidebar';
// Storage bar width (expanded) — matches the FULL NavItem hover-row extent:
// sidebar w-64 (256px) − nav px-4 right (16px, row hover right edge at 240px)
// − storage px-4 left (16px) − track ml-3 (12px) = 212px. The row's hover
// background spans its whole px-3 row box, so aligning to that (not the
// icon+text content) makes the bar's right edge line up with the hover zone
// of the Home/My Drive rows above. A fixed width (instead of `flex-1`/max-w)
// is required so the collapsed <-> expanded width transition can animate
// smoothly between two concrete values.
const STORAGE_BAR_WIDTH_CLASS = 'w-[212px]';

// Usage fraction at which the quota bar fill and the usage text switch from
// blue to red. Mirrors Google's behavior of flagging accounts that cross 80%
// of their storage limit (Stanford UIT docs:
// uit.stanford.edu/project/google-workspace-optimization/understanding-google-
// storage-limit-alerts); 0.8 = 80% of the account limit. Exactly at the
// threshold is still treated as safe (<= threshold, not <).
const STORAGE_WARNING_THRESHOLD = 0.8;

interface SidebarProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  userProfile?: { name: string; email: string; picture: string } | null;
  onLogout?: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  token?: string | null;
}

export type { SidebarProps };

export function Sidebar({ activeTab, onTabChange, onLogout, userProfile, isSidebarOpen, onToggleSidebar, token }: SidebarProps) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [quota, setQuota] = useState<DriveStorageQuota | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPlaylists().then(data => { if (!cancelled) setPlaylists(data); }).catch(err => captureError({ level: 'error', source: SIDEBAR_MODULE, message: `failed-to-load-playlists: ${err instanceof Error ? err.message : String(err)}` }));
    const handleUpdate = () => getPlaylists().then(data => { if (!cancelled) setPlaylists(data); }).catch(err => captureError({ level: 'error', source: SIDEBAR_MODULE, message: `failed-to-load-playlists: ${err instanceof Error ? err.message : String(err)}` }));
    window.addEventListener('playlists-updated', handleUpdate);
    window.addEventListener('user-changed', handleUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('playlists-updated', handleUpdate);
      window.removeEventListener('user-changed', handleUpdate);
    };
  }, []);

  // Storage quota: only for a logged-in user (token present). Re-fetched on
  // 'user-changed' (account switch re-keys Drive storage entirely) and reset
  // when the token goes away (logout). Failure hides the section silently —
  // getDriveStorageQuota never throws by contract; the catch is defensive so
  // a future regression cannot crash the sidebar.
  useEffect(() => {
    if (!token) {
      setQuota(null);
      return;
    }
    let cancelled = false;
    const loadQuota = () => {
      getDriveStorageQuota(token)
        .then(data => { if (!cancelled) setQuota(data); })
        .catch(err => captureError({ level: 'warn', source: SIDEBAR_MODULE, message: `storage-quota-failed: ${err instanceof Error ? err.message : String(err)}` }));
    };
    loadQuota();
    window.addEventListener('user-changed', loadQuota);
    return () => {
      cancelled = true;
      window.removeEventListener('user-changed', loadQuota);
    };
  }, [token]);

  const usageFraction = quota && quota.limit !== null && quota.limit > 0 ? quota.usageInDrive / quota.limit : 0;
  const isOverThreshold = usageFraction > STORAGE_WARNING_THRESHOLD;
  // Two-segment fill: the safe zone (0 → threshold) stays blue, and only the
  // excess above the threshold turns red; the remaining track stays gray.
  // Clamped so the segments never exceed the track width, even when usage is
  // past the account limit (the two segments cap at 100% total).
  const usagePercent = quota && quota.limit !== null && quota.limit > 0
    ? Math.min(100, Math.round((quota.usageInDrive / quota.limit) * 100))
    : 0;
  const thresholdPercent = quota && quota.limit !== null && quota.limit > 0
    ? Math.round((quota.limit * STORAGE_WARNING_THRESHOLD / quota.limit) * 100)
    : 0;
  const safeZonePercent = Math.min(usagePercent, thresholdPercent);
  const excessPercent = Math.max(0, usagePercent - thresholdPercent);

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
      captureError({ level: 'error', source: SIDEBAR_MODULE, message: `create-playlist-failed: ${err instanceof Error ? err.message : String(err)}` });
      showErrorToast(t('sidebar.create_playlist_error') || "Failed to create playlist");
    } finally {
      setNewPlaylistName("");
      setIsCreating(false);
    }
  };

  return (
    <aside className={`${isSidebarOpen ? 'w-64' : 'w-20'} bg-[#F8F9FA] dark:bg-[#121212] h-full flex flex-col shrink-0 transition-all duration-300 overflow-hidden border-r border-gray-200/50 dark:border-gray-800/50`}>
      <div className="px-7 py-6 flex items-center cursor-pointer transition-all duration-300" onClick={onToggleSidebar}>
        <h1 className="text-xl font-bold flex items-center text-[#4285F4] w-full" title="DrPlay">
          <HardDrive className="w-6 h-6 shrink-0" />
          <div className={`overflow-hidden transition-all duration-300 whitespace-nowrap flex items-center ${isSidebarOpen ? 'max-w-[100px] opacity-100 ml-2' : 'max-w-0 opacity-0 ml-0'}`}>
            <span className="truncate">DrPlay</span>
          </div>
          {/* ml-auto pushes the + to the header's right edge; -mr-3 (12px)
              cancels the difference between the header's px-7 (28px) and the
              nav rows' px-4 (16px) right padding, so the + lines up flush
              with the nav rows' hover zone below (right edge 240px) instead
              of stopping 12px short of it. */}
          {isSidebarOpen && <div className="ml-auto -mr-3"><UploadButton token={token} disabled={activeTab !== TABS.myDrive} /></div>}
        </h1>
      </div>
      <nav className="px-4 space-y-1 mb-2">
        <NavItem icon={<Home />} label={t('sidebar.home')} active={activeTab === TABS.home} onClick={() => onTabChange(TABS.home)} isSidebarOpen={isSidebarOpen} />
        <NavItem icon={<HardDrive />} label={t('sidebar.my_drive')} active={activeTab === TABS.myDrive} onClick={() => onTabChange(TABS.myDrive)} isSidebarOpen={isSidebarOpen} />
        <NavItem icon={<Heart />} label={t('sidebar.liked_songs')} active={activeTab === TABS.likedSongs} onClick={() => onTabChange(TABS.likedSongs)} isSidebarOpen={isSidebarOpen} />
      </nav>
      
      <div className={`px-4 mt-6 mb-2 flex items-center group transition-all duration-300 ${isSidebarOpen ? 'justify-between' : ''}`}>
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

      {token && quota && (isSidebarOpen || quota.limit !== null) && (
        <div
          data-testid="storage-quota"
          title={!isSidebarOpen && quota.limit !== null ? `${formatBytes(quota.usageInDrive)} / ${formatBytes(quota.limit)}` : undefined}
          className="flex items-center transition-all duration-300 px-4 pb-4"
        >
          <div>
            {quota.limit !== null && (
              <div data-testid="storage-quota-track" className={`h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full overflow-hidden transition-all duration-300 ease-in-out ml-3 flex items-stretch ${isSidebarOpen ? STORAGE_BAR_WIDTH_CLASS : 'w-11'}`}>
                <div data-testid="storage-quota-bar" className={`h-full bg-[#4285F4] ${excessPercent > 0 ? 'rounded-l-full' : 'rounded-full'}`} style={{ width: `${safeZonePercent}%` }} />
                {excessPercent > 0 && (
                  <div data-testid="storage-quota-bar-red" className="h-full bg-red-500 rounded-r-full" style={{ width: `${excessPercent}%` }} />
                )}
              </div>
            )}
            {/* Always mounted to reserve fixed space below the track (mt-1.5 + h-4),
                so the track never jumps when the text appears/disappears. Collapsed:
                invisible (opacity-0). Enter and exit are both pure CSS TRANSITIONS
                (NOT tw-animate keyframes — the old animate-out started from the
                element's current computed style, which was already opacity-0 from
                the static class, so the whole exit ran invisible; the old
                animate-in used a different keyframe mechanism, so enter and exit
                felt mismatched). The same transition-all (present in BOTH states
                so the browser reads it as the before-change style) fades the text
                in while gliding down from 8px above (opacity-0 -translate-y-2 →
                opacity-100 translate-y-0) over 300ms, easing in-out, and runs
                SIMULTANEOUSLY with the track width transition (no delay) — exit is
                the exact reverse, so both directions share the same easing and
                feel. The 300ms is synced with the track's duration-300 (was
                150ms: the text finished fading while the track/sidebar kept
                growing for another 150ms → visible stutter on expand). Note:
                overflow-hidden is ALWAYS present, not only when collapsed — on
                expand the wrapper is still narrow (track at w-11, growing), and
                without clipping the text wraps to 2 lines and spills out of the
                fixed h-4 over the section below (the reported short jank).
                Limitation: the wrapper's width is squeezed by the shrinking
                track (no width transition on this element), so the slide is
                accompanied by a horizontal collapse of the clipped area. */}
            <div
              data-testid="storage-quota-text"
              className={`mt-1.5 h-4 ml-3 overflow-hidden transition-all duration-300 ease-in-out ${isSidebarOpen ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}
            >
              {quota.limit !== null ? (
                <p className="text-xs">
                  <span data-testid="storage-quota-usage" className={isOverThreshold ? 'text-red-500' : 'text-[#4285F4]'}>{formatBytes(quota.usageInDrive)}</span>
                  <span data-testid="storage-quota-limit" className="text-gray-500 dark:text-gray-400">{' / '}{formatBytes(quota.limit)}</span>
                </p>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('sidebar.storage_unlimited')} {formatBytes(quota.usageInDrive)}</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="p-4">
        <NavItem icon={<Settings />} label={t('sidebar.settings')} active={activeTab === TABS.settings} onClick={() => onTabChange(TABS.settings)} isSidebarOpen={isSidebarOpen} />
        
        <div className="mt-4 pt-4 flex items-center transition-all duration-300">
          <div className="ml-1 shrink-0 flex items-center justify-center">
            {userProfile ? (
              <img 
                src={userProfile.picture} 
                alt={t('common.profile_alt', 'Profile')} 
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
      <DropZone token={token} />
    </aside>
  );
}

function NavItem({ icon, label, active, onClick, isSidebarOpen }: { icon: React.ReactNode, label: string, active?: boolean, onClick: () => void, isSidebarOpen: boolean }) {
  return (
    <div 
      onClick={onClick}
      title={!isSidebarOpen ? label : undefined}
      className={`group flex items-center px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 active:scale-[0.98] font-medium ${
        active 
          ? 'bg-[#4285F4]/10 text-[#4285F4] shadow-sm' 
          : 'text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-[#2a2b2f] hover:text-gray-900 dark:hover:text-white'
      }`}
    >
      <div className={`w-6 h-6 flex items-center justify-center shrink-0 transition-colors ${active ? 'text-[#4285F4]' : 'opacity-70 group-hover:text-[#4285F4] group-hover:opacity-100'}`}>
        {icon}
      </div>
      <div className={`overflow-hidden transition-all duration-300 whitespace-nowrap ${isSidebarOpen ? 'max-w-[150px] opacity-100 ml-3 flex-1' : 'max-w-0 opacity-0 ml-0'}`}>
        <span className="text-sm block truncate group-hover:text-[#4285F4]">{label}</span>
      </div>
    </div>
  );
}
