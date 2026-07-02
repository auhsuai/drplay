import { useState, useEffect, useRef } from "react";


import { Sidebar } from "./ui/Sidebar/Sidebar";
import { MainContent } from "./ui/MainContent/MainContent";
import { HomeTab } from "./ui/HomeTab/HomeTab";
import { LikedSongs } from "./ui/LikedSongs/LikedSongs";
import { PlaylistView } from './ui/Playlist/PlaylistView';
import { NowPlayingView } from "./ui/NowPlaying/NowPlayingView";
import { PlayerBar } from "./ui/PlayerBar/PlayerBar";
import { FolderSelectionScreen } from "./ui/FolderSelection/FolderSelectionScreen";
import { TrashScreen } from "./ui/Settings/TrashScreen";
import { GlobalContextMenu } from "./ui/components/GlobalContextMenu";
import "./App.css";
import { db } from './db/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { LoginScreen } from "./ui/Login/LoginScreen";

import { fetchWithAuth } from "./utils/apiClient";
import { useAuth } from "./hooks/useAuth";
import { usePlayer } from "./hooks/usePlayer";
import { useDrive } from "./hooks/useDrive";
import { useTheme } from "./hooks/useTheme";
import { SettingsTab } from "./ui/Settings/SettingsTab";export type Track = {
  id: string;
  title: string;
  artist: string;
  streamUrl: string;
  size?: number;
  originalName?: string;
  restoreTime?: number;
  restoreDuration?: number;
  parentId?: string;
  parentName?: string;
};

export type DriveItem = {
  id: string;
  title: string;
  isFolder: boolean;
  trackInfo?: Track;
  size?: number;
  modifiedTime?: string;
};

export type BreadcrumbItem = {
  id: string;
  name: string;
};

export type UserProfile = {
  name: string;
  email: string;
  picture: string;
};

function App() {
  const [activeTab, setActiveTab] = useState("Home");
  const [driveItems, setDriveItems] = useState<DriveItem[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const { theme, setTheme } = useTheme();
  const [showTrashScreen, setShowTrashScreen] = useState(false);

  const { isLoggedIn, accessToken, userProfile, handleLoginSuccess, handleLogout } = useAuth(() => {
    localStorage.removeItem("drplay_root_folder");
    localStorage.removeItem("drplay_current_folder_id");
    localStorage.removeItem("drplay_current_folder_name");
    localStorage.removeItem("drplay_folder_history");
    db.syncState.delete("drplay_nav_state").catch(() => {});
    setAppRootFolder(null);
  });

  const {
    appRootFolder,
    setAppRootFolder,
    currentFolderId,
    setCurrentFolderId,
    currentFolderName,
    setCurrentFolderName,
    folderHistory,
    setFolderHistory,
    sortOption,
    setSortOption,
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
    handleSelectRootFolder
  } = useDrive(isLoggedIn);

  const {
    currentTrack,
    isPlaying,
    isDownloading,
    playMode,
    bufferSeconds,
    setBufferSeconds,
    handlePlayTrack: playerPlayTrack,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlay,
    handleTogglePlayMode
  } = usePlayer(accessToken);

  const handlePlayTrack = (track: Track, contextQueue?: Track[], isNavigation: boolean = false) => {
    playerPlayTrack(track, contextQueue, isNavigation, driveItems, activeTab);
  };

  const [showFolderSelection, setShowFolderSelection] = useState(false);
  const [scanMode, setScanMode] = useState<'fast' | 'full'>('fast');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [highlightedFileId, setHighlightedFileId] = useState<{id: string, ts: number} | null>(null);
  const pendingEnsuredFileId = useRef<string | null>(null);
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);




  // Locate File in App logic
  useEffect(() => {
    const handleLocateFile = async (e: any) => {
      const { fileId, alreadyInCurrentFolder } = e.detail || {};
      if (!fileId || !accessToken) return;

      const rebuildHistory = async (targetFolderId: string) => {
        const rootRaw = localStorage.getItem("drplay_root_folder");
        let rootId = 'root';
        if (rootRaw) {
          try { rootId = JSON.parse(rootRaw).id; } catch (e) { }
        }
        try {
          let current = targetFolderId;
          const newHistory: { id: string, name: string }[] = [];
          let limit = 10;
          while (current !== rootId && current !== 'root' && limit > 0) {
            limit--;
            const res = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${current}?fields=parents`, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (!res.ok) break;
            const data = await res.json();
            if (!data.parents || data.parents.length === 0) break;

            const pId = data.parents[0];
            if (pId === rootId || pId === 'root') break;

            const pRes = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${pId}?fields=id,name`, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (!pRes.ok) break;
            const pData = await pRes.json();
            newHistory.unshift({ id: pData.id, name: pData.name });
            current = pId;
          }
          setFolderHistory(newHistory);
        } catch (e) {
          console.error("Rebuild history failed", e);
        }
      };


      // If we already know it's in the current folder, skip API entirely!
      if (alreadyInCurrentFolder) {
        setActiveTab("My Drive");
        setHighlightedFileId({id: fileId, ts: Date.now()});
        setTimeout(() => setHighlightedFileId(null), 5000);
        return;
      }


      setIsLoadingTracks(true);
      setActiveTab("My Drive");

      try {
        const response = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (response.ok) {
          const data = await response.json();
          if (data.parents && data.parents.length > 0) {
            const parentId = data.parents[0];

            // Try to get parent name
            const pRes = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${parentId}?fields=name`, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            let folderName = "Đã định vị";
            if (pRes.ok) {
              const pData = await pRes.json();
              folderName = pData.name;
            }

            // Navigate
            setFolderHistory([]);
            pendingEnsuredFileId.current = fileId;
            setCurrentFolderId(parentId);
            setCurrentFolderName(folderName);
            setHighlightedFileId({id: fileId, ts: Date.now()});

            // Clear highlight after 5 seconds
            setTimeout(() => setHighlightedFileId(null), 5000);

            rebuildHistory(parentId);
          }
        }
      } catch (err) {
        console.error("Locate file failed", err);
      } finally {
        setIsLoadingTracks(false);
      }
    };

    window.addEventListener('locate-file', handleLocateFile);
    return () => window.removeEventListener('locate-file', handleLocateFile);
  }, [accessToken, currentFolderId]);

  // Lắng nghe event logout từ apiClient
  useEffect(() => {
    const handleAuthLogout = () => {
      handleLogout();
    };
    window.addEventListener('auth-logout', handleAuthLogout);
    return () => window.removeEventListener('auth-logout', handleAuthLogout);
  }, []);

  // Lắng nghe event refresh-drive để tải lại thư mục hiện tại
  useEffect(() => {
    const handleRefreshDrive = () => {
      if (isLoggedIn && accessToken && currentFolderId) {
        fetchFolderContentsToDexie(accessToken, currentFolderId);
      }
    };
    window.addEventListener('refresh-drive', handleRefreshDrive);
    return () => window.removeEventListener('refresh-drive', handleRefreshDrive);
  }, [isLoggedIn, accessToken, currentFolderId]);

  const dbFiles = useLiveQuery(
    () => db.files.where('parentId').equals(currentFolderId).toArray(),
    [currentFolderId]
  );

  useEffect(() => {
    if (dbFiles) {
      const items: DriveItem[] = dbFiles.map(file => {
        const title = file.isFolder ? file.name : file.name.replace(/\.[^/.]+$/, "");
        return {
          id: file.id,
          title,
          isFolder: file.isFolder,
          size: file.size,
          modifiedTime: file.modifiedTime,
          trackInfo: file.isFolder ? undefined : {
            id: file.id,
            title,
            artist: "",
            streamUrl: "",
            size: file.size,
            originalName: file.name,
            parentId: file.parentId,
            parentName: currentFolderName,
          }
        };
      });

      // Use Intl.Collator for natural sorting (handles numbers correctly and is case-insensitive)
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

      // Sort items
      const sortedItems = items.sort((a, b) => {
        if (a.isFolder && !b.isFolder) return -1;
        if (!a.isFolder && b.isFolder) return 1;
        
        switch (sortOption) {
          case 'name':
            return collator.compare(a.title, b.title);
          case 'name desc':
            return collator.compare(b.title, a.title);
          case 'modifiedTime': {
            const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
            const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
            if (timeA === timeB) return collator.compare(a.title, b.title);
            return timeA - timeB;
          }
          case 'modifiedTime desc': {
            const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
            const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
            if (timeA === timeB) return collator.compare(a.title, b.title);
            return timeB - timeA;
          }
          case 'size': {
            const diff = (a.size || 0) - (b.size || 0);
            if (diff === 0) return collator.compare(a.title, b.title);
            return diff;
          }
          case 'size desc': {
            const diff = (b.size || 0) - (a.size || 0);
            if (diff === 0) return collator.compare(a.title, b.title);
            return diff;
          }
          default:
            return collator.compare(a.title, b.title);
        }
      });

      setDriveItems(sortedItems);
    }
  }, [dbFiles, sortOption, currentFolderName]);

  const fetchFolderContentsToDexie = async (token: string, folderId: string) => {
    try {
      const existingCount = await db.files.where('parentId').equals(folderId).count();
      if (existingCount === 0) {
        setIsLoadingTracks(true);
      }
      
      const q = `'${folderId}' in parents and trashed=false and (mimeType='application/vnd.google-apps.folder' or mimeType contains 'audio/')`;
      const response = await fetchWithAuth(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=1000`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.files) {
          const filesToInsert = data.files.map((file: any) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            parentId: folderId,
            size: file.size ? parseInt(file.size, 10) : undefined,
            modifiedTime: file.modifiedTime,
            trashed: false,
            isFolder: file.mimeType === "application/vnd.google-apps.folder"
          }));
          
          if (filesToInsert.length > 0) {
            await db.files.bulkPut(filesToInsert);
          }

          // Sync deletions: remove local files that are no longer in Google Drive
          const fetchedIds = new Set(filesToInsert.map((f: any) => f.id));
          const localFiles = await db.files.where('parentId').equals(folderId).toArray();
          const idsToDelete = localFiles
            .filter(f => !fetchedIds.has(f.id))
            .map(f => f.id);
            
          if (idsToDelete.length > 0) {
            await db.files.bulkDelete(idsToDelete);
          }
        }
      }
    } catch (error) {
      console.error("Failed to fetch folder contents on demand:", error);
    } finally {
      setIsLoadingTracks(false);
    }
  };

  useEffect(() => {
    if (isLoggedIn && accessToken && currentFolderId) {
      fetchFolderContentsToDexie(accessToken, currentFolderId);
    }
  }, [isLoggedIn, accessToken, currentFolderId]);

  useEffect(() => {
    const handleSyncProgress = () => { /* can show partial loaded items */ };
    const handleSyncComplete = () => setIsLoadingTracks(false);

    window.addEventListener('pro-sync-progress', handleSyncProgress);
    window.addEventListener('pro-sync-complete', handleSyncComplete);

    return () => {
      window.removeEventListener('pro-sync-progress', handleSyncProgress);
      window.removeEventListener('pro-sync-complete', handleSyncComplete);
    };
  }, []);



  const handleTabChange = (tab: string) => {
      // If already on My Drive and clicks it again, reset to root
      if (activeTab === tab && tab === "My Drive") {
        setCurrentFolderId(appRootFolder || "root");
        setCurrentFolderName("My Drive");
        setFolderHistory([]);
      }
      setActiveTab(tab);
    };

    return (
      <div className="relative flex flex-col h-screen overflow-hidden bg-white dark:bg-[#121212] transition-colors duration-300">
        {/* Login Overlay */}
        {!isLoggedIn && <LoginScreen onLogin={handleLoginSuccess} />}

        {/* Folder Selection Overlay */}
        {(isLoggedIn && (!appRootFolder || showFolderSelection)) && (
          <FolderSelectionScreen
            token={accessToken!}
            onSelectFolder={(folderId) => {
              handleSelectRootFolder(folderId);
              setShowFolderSelection(false);
            }}
            onCancel={appRootFolder ? () => setShowFolderSelection(false) : undefined}
            initialFolderId={appRootFolder || 'root'}
          />
        )}

        {showTrashScreen && accessToken && (
          <TrashScreen token={accessToken} onClose={() => setShowTrashScreen(false)} />
        )}

        <div className={`flex flex-1 overflow-hidden transition-all duration-700 ease-in-out ${(!isLoggedIn || (!appRootFolder && !showFolderSelection)) ? 'blur-xl scale-[0.97] opacity-40 pointer-events-none' : 'blur-0 scale-100 opacity-100'}`}>
          <Sidebar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            userProfile={userProfile}
            onLogout={handleLogout}
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          />

          <div className="flex-1 relative overflow-hidden flex flex-col">
            {activeTab === "Home" ? (
              <HomeTab onPlay={(t: Track, c?: Track[]) => handlePlayTrack(t, c)} token={accessToken} />
            ) : activeTab === "My Drive" ? (
              <MainContent
                activeTab={activeTab}
                onPlay={(t: Track) => { handlePlayTrack(t); }}
                currentTrack={currentTrack}
                items={driveItems}
                isLoading={isLoadingTracks}
                onOpenFolder={handleOpenFolder}
                onBack={handleBack}
                hasHistory={folderHistory.length > 0}
                folderHistory={folderHistory}
                currentFolderName={currentFolderName}
                currentFolderId={currentFolderId}
                onBreadcrumbClick={handleBreadcrumbClick}
                token={accessToken}
                highlightedFileId={highlightedFileId}
                onRefresh={() => { /* No-op, sync runs in background */ }}
                onRemoveItem={(id: string) => setDriveItems(prev => prev.filter(item => item.id !== id))}
                sortOption={sortOption}
                onSortChange={(val) => {
                  setSortOption(val);
                  localStorage.setItem("drplay_sort_option", val);
                }}
              />
            ) : activeTab === "Liked Songs" ? (
              <LikedSongs onPlay={(t: Track, c: Track[]) => { handlePlayTrack(t, c); }} token={accessToken} currentTrack={currentTrack} />
            ) : activeTab.startsWith("playlist_") ? (
              <PlaylistView
                playlistId={activeTab.replace("playlist_", "")}
                onPlay={(t: Track, c?: Track[]) => { handlePlayTrack(t, c); }}
                onDelete={() => handleTabChange("Home")}
                currentTrack={currentTrack}
              />
            ) : activeTab === "Settings" ? (
              <SettingsTab
                theme={theme}
                setTheme={setTheme}
                bufferSeconds={bufferSeconds}
                setBufferSeconds={setBufferSeconds}
                scanMode={scanMode}
                setScanMode={setScanMode}
                setShowFolderSelection={setShowFolderSelection}
                setShowTrashScreen={setShowTrashScreen}
              />
            ) : (
              <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto flex items-center justify-center transition-colors duration-300">
                <h1 className="text-2xl text-gray-500">Coming Soon: {activeTab}</h1>
              </main>
            )}

          </div>
        </div>

        <div className={`transition-all duration-700 ease-in-out ${(!isLoggedIn || !appRootFolder) ? 'blur-xl opacity-40 pointer-events-none translate-y-4' : 'blur-0 opacity-100 translate-y-0'} ${isNowPlayingOpen ? 'h-0 overflow-hidden pointer-events-none opacity-0' : ''}`}>
          <PlayerBar
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            onTogglePlay={handleTogglePlay}
            onNextTrack={handleNextTrack}
            onPrevTrack={handlePrevTrack}
            isDownloading={isDownloading}
            playMode={playMode}
            onTogglePlayMode={handleTogglePlayMode}
            onExpandNowPlaying={() => setIsNowPlayingOpen(true)}
            bufferSeconds={bufferSeconds}
          />
        </div>
        
        {/* Now Playing Full Screen Overlay */}
        <div
          className={`fixed inset-0 z-[9999] bg-white dark:bg-[#121212] flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${isNowPlayingOpen ? 'translate-y-0' : 'translate-y-full pointer-events-none'
            }`}
        >
          <NowPlayingView
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            onTogglePlay={handleTogglePlay}
            onNextTrack={handleNextTrack}
            onPrevTrack={handlePrevTrack}
            playMode={playMode}
            onTogglePlayMode={handleTogglePlayMode}
            onBack={() => setIsNowPlayingOpen(false)}
            isOpen={isNowPlayingOpen}
          />
        </div>
        
        <GlobalContextMenu />
      </div>
    );
  }
  export default App;
