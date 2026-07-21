import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Sidebar } from "./ui/Sidebar/Sidebar";
import { PlayerBar } from "./ui/PlayerBar/PlayerBar";
import { FolderSelectionScreen } from "./ui/FolderSelection/FolderSelectionScreen";
import { TrashScreen } from "./ui/Settings/TrashScreen";
import React, { Suspense } from "react";

const MainContent = React.lazy(() => import('./ui/MainContent/MainContent').then(module => ({ default: module.MainContent })));
const HomeTab = React.lazy(() => import('./ui/HomeTab/HomeTab').then(module => ({ default: module.HomeTab })));
const LikedSongs = React.lazy(() => import('./ui/LikedSongs/LikedSongs').then(module => ({ default: module.LikedSongs })));
const PlaylistView = React.lazy(() => import('./ui/Playlist/PlaylistView').then(module => ({ default: module.PlaylistView })));
const SettingsTab = React.lazy(() => import('./ui/Settings/SettingsTab').then(module => ({ default: module.SettingsTab })));
import "./App.css";
import { db } from './db/db';
import { del as kvDel } from './db/kv';
import { getFolderAudioQuery } from './utils/audioQuery';
import { useLiveQuery } from 'dexie-react-hooks';
import { LoginScreen } from "./ui/Login/LoginScreen";

import { getValidToken } from "./utils/apiClient";
import { driveFetch } from "./utils/driveApi";
import { useAuth } from "./hooks/useAuth";
import { usePlayer } from "./hooks/usePlayer";
import { useDrive } from "./hooks/useDrive";
import { useTheme } from "./hooks/useTheme";
import { createFolderFetchGuard } from "./utils/folderFetchGuard";

export type Track = {
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
  queueItemId?: string;
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

const folderFetchGuard = createFolderFetchGuard();

const APP_MODULE = "App";

// Derive a short, safe classification tag from an error's message ONLY.
// We never log the error object or its stack — those can leak file ids, user
// data, or (in theory) auth material into logs. Mirrors classifyDriveError
// in driveApi.ts.
function classifyAppError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown-error";
  const m = msg.toLowerCase();
  if (m.includes("timeout") || m.includes("aborterror")) return "timeout";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("unreachable"))
    return "network";
  const statusMatch = m.match(/\((\d{3})\)/);
  if (statusMatch) return `http-${statusMatch[1]}`;
  return "unknown";
}

function App() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState("Home");
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const { theme, setTheme } = useTheme();
  const [showTrashScreen, setShowTrashScreen] = useState(false);
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    const handleFocus = () => {
      setIsFocused(true);
      // The proactive-refresh setTimeout is frozen while the OS sleeps / the app
      // is suspended. On regaining focus, refresh if the token is stale so the
      // next play doesn't hit the proxy with an expired token. Guard on
      // refresh_token presence to avoid triggering the logout path when signed out.
      if (localStorage.getItem("drplay_access_token") && localStorage.getItem("drplay_refresh_token")) {
        getValidToken().catch(e => console.warn("[Auth] Focus refresh failed", e));
      }
    };
    const handleBlur = () => setIsFocused(false);
    const preventContextMenu = (e: MouseEvent) => e.preventDefault();
    
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener('contextmenu', preventContextMenu);
    
    setIsFocused(document.hasFocus());
    
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener('contextmenu', preventContextMenu);
    };
  }, []);

  const { isLoggedIn, accessToken, userProfile, handleLoginSuccess, handleLogout } = useAuth(() => {
    localStorage.removeItem("drplay_root_folder");
    db.syncState.delete("drplay_nav_state").catch((e) => console.warn(`[${APP_MODULE}] logout-cleanup-failed`, classifyAppError(e)));
    kvDel('drplay_last_session').catch((e) => console.warn(`[${APP_MODULE}] logout-cleanup-failed`, classifyAppError(e)));
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
  } = useDrive(isLoggedIn, accessToken);

  const [showRateLimitModal, setShowRateLimitModal] = useState(false);

  useEffect(() => {
    let quotaFn: (() => void) | null = null;
    let cancelled = false;
    listen('drive-quota-exceeded', () => {
      setShowRateLimitModal(true);
    }).then(fn => {
      if (cancelled) { fn(); return; }
      quotaFn = fn;
    });

    return () => {
      cancelled = true;
      quotaFn?.();
    };
  }, []);

  const {
    currentTrack,
    isPlaying,
    isDownloading,
    playMode,
    handlePlayTrack: playerPlayTrack,
    handleNextTrack,
    handlePrevTrack,
    handleTogglePlay,
    handleTogglePlayMode,
    loadNonce
  } = usePlayer(accessToken);

  const stableHandleTogglePlay = useCallback(handleTogglePlay, [handleTogglePlay]);
  const stableHandleNextTrack = useCallback(handleNextTrack, [handleNextTrack]);
  const stableHandlePrevTrack = useCallback(handlePrevTrack, [handlePrevTrack]);
  const stableHandleTogglePlayMode = useCallback(handleTogglePlayMode, [handleTogglePlayMode]);

  const dbFiles = useLiveQuery(
    () => {
      // Return empty if currentFolderId is not initialized to avoid unnecessary queries
      if (!currentFolderId) return Promise.resolve<any[]>([]);
      return db.files.where('parentId').equals(currentFolderId).toArray()
    },
    [currentFolderId]
  );

  const driveItems = useMemo(() => {
    if (!dbFiles) return [];
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

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return items.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      
      switch (sortOption) {
        case 'name': {
          return collator.compare(a.title, b.title);
        }
        case 'name desc': {
          return collator.compare(b.title, a.title);
        }
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
        default: {
          return collator.compare(a.title, b.title);
        }
      }
    });
  }, [dbFiles, sortOption, currentFolderName]);

  const handlePlayTrack = (track: Track, contextQueue?: Track[], isNavigation: boolean = false) => {
    playerPlayTrack(track, contextQueue, isNavigation, driveItems, activeTab);
  };

  const [showFolderSelection, setShowFolderSelection] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [highlightedFileId, setHighlightedFileId] = useState<{id: string, ts: number} | null>(null);
  const pendingEnsuredFileId = useRef<string | null>(null);
  const [minimizeToTray, setMinimizeToTray] = useState(() => {
    const saved = localStorage.getItem("drplay_minimize_to_tray");
    return saved !== null ? saved === "true" : true;
  });

  useEffect(() => {
    localStorage.setItem("drplay_minimize_to_tray", String(minimizeToTray));
    invoke("update_minimize_to_tray", { minimize: minimizeToTray }).catch((e) => console.warn(`[${APP_MODULE}] minimize-to-tray-failed`, classifyAppError(e)));
  }, [minimizeToTray]);

  // Locate File in App logic
  useEffect(() => {
    const handleLocateFile = async (e: any) => {
      let { fileId } = e.detail || {};
      if (!fileId || !accessToken) return;
      
      if (fileId.startsWith('drive_')) {
        fileId = fileId.replace('drive_', '');
      }

      const rebuildHistory = async (targetFolderId: string): Promise<{ id: string, name: string }[]> => {
        const rootRaw = localStorage.getItem("drplay_root_folder");
        const rootId = rootRaw || 'root';
        
        let current = targetFolderId;
        const newHistory: { id: string, name: string }[] = [];
        let limit = 20; 
        
        while (current !== rootId && current !== 'root' && limit > 0) {
          limit--;
          
          let pId: string | undefined;
          const folderInfo = await db.files.get(current);
          
          if (!folderInfo || !folderInfo.parentId) {
            try {
              const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${current}?fields=parents`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (res.ok) {
                const data = await res.json();
                if (data.parents && data.parents.length > 0) {
                  pId = data.parents[0];
                }
              }
            } catch (e) {
              console.warn(`[${APP_MODULE}] Failed to get parents via API`, classifyAppError(e));
            }
            if (!pId) break;
          } else {
            pId = folderInfo.parentId;
          }

          if (pId === rootId || pId === 'root') {
            newHistory.unshift({ id: pId, name: "My Drive" });
            break;
          }

          const parentInfo = await db.files.get(pId);
          if (!parentInfo) {
            try {
              const pRes = await driveFetch(`https://www.googleapis.com/drive/v3/files/${pId}?fields=name`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (pRes.ok) {
                const pData = await pRes.json();
                newHistory.unshift({ id: pId, name: pData.name });
              } else {
                newHistory.unshift({ id: pId, name: "Unknown Folder" });
              }
            } catch (e) {
              console.warn(`[${APP_MODULE}] parent-name-fetch-failed`, classifyAppError(e));
              newHistory.unshift({ id: pId, name: "Unknown Folder" });
            }
          } else {
            newHistory.unshift({ id: parentInfo.id, name: parentInfo.name });
          }
          current = pId;
        }
        return newHistory;
      };

      setIsLoadingTracks(true);
      setActiveTab("My Drive");

      try {
        let parentId: string | null = null;
        let folderName = "Unknown Folder";
        
        // Resolve the file's CURRENT parent straight from Drive. The local
        // Dexie cache (db.files.parentId) can be stale after the file is
        // moved in Drive, which made "Locate" open the old folder until a
        // full restart re-fetched everything. Prefer the live API result and
        // only fall back to the cache if the API call fails.
        try {
          const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (response.ok) {
            const data = await response.json();
            if (data.parents && data.parents.length > 0) {
              parentId = data.parents[0];
            }
          }
        } catch (e) {
          console.warn(`[${APP_MODULE}] locate-parent-api-failed`, classifyAppError(e));
          // ignore — fall back to cache below
        }
        if (!parentId) {
          const fileInfo = await db.files.get(fileId);
          if (fileInfo && fileInfo.parentId) {
            parentId = fileInfo.parentId;
          }
        }
        
        if (!parentId) throw new Error("Could not determine parent folder");
        
        const rootRaw = localStorage.getItem("drplay_root_folder");
        const rootId = rootRaw || 'root';
        
        if (parentId === rootId || parentId === 'root') {
          folderName = "My Drive";
        } else {
          const parentInfo = await db.files.get(parentId);
          if (parentInfo) {
            folderName = parentInfo.name;
          } else {
             const pRes = await driveFetch(`https://www.googleapis.com/drive/v3/files/${parentId}?fields=name`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (pRes.ok) {
                const pData = await pRes.json();
                folderName = pData.name;
              }
          }
        }

        // If the file already lives in the folder we're viewing, just
        // highlight it — no navigation needed.
        if (parentId === currentFolderId) {
          setHighlightedFileId({ id: fileId, ts: Date.now() });
          setTimeout(() => setHighlightedFileId(null), 5000);
          return;
        }

        const newHistory = await rebuildHistory(parentId);
        
        setFolderHistory(newHistory);
        pendingEnsuredFileId.current = fileId;
        setCurrentFolderId(parentId);
        setCurrentFolderName(folderName);
        setHighlightedFileId({id: fileId, ts: Date.now()});

        setTimeout(() => setHighlightedFileId(null), 5000);
      } catch (err) {
        console.error(`[${APP_MODULE}] Locate file failed`, classifyAppError(err));
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

  // Lắng nghe event refresh-drive để tải lại thư mục hiện tại.
  // Dùng chung fetchFolderContentsToDexie (khai báo ở dưới) để không bị lệch
  // logic — bản nội bộ cũ thiếu bước xoá các file không còn trên Drive.
  useEffect(() => {
    const handleRefreshDrive = () => {
      if (isLoggedIn && accessToken && currentFolderId) {
        fetchFolderContentsToDexie(accessToken, currentFolderId);
      }
    };
    window.addEventListener('refresh-drive', handleRefreshDrive);
    return () => window.removeEventListener('refresh-drive', handleRefreshDrive);
  }, [isLoggedIn, accessToken, currentFolderId]);

  async function fetchFolderContentsToDexie(token: string, folderId: string) {
    const myId = folderFetchGuard.start();
    let fetchCompleted = true;
    try {
      const existingCount = await db.files.where('parentId').equals(folderId).count();
      if (existingCount === 0) {
        setIsLoadingTracks(true);
      }
      
      const q = getFolderAudioQuery(folderId);

      // Ask Drive to return each page already in (approximately) the same
      // order this folder is currently displayed in, instead of Drive's own
      // unspecified order. Complements the bulkPut-coalescing fix below:
      // even with that fix, pages still eventually get merged into the same
      // sorted `driveItems` list, and if a later page's items are
      // completely unrelated to the current sort order, the final combined
      // sort can still noticeably reorder what's on-screen once that page
      // lands. With the fetch order pre-aligned to the current sort, each
      // new page's items mostly slot in at/near the end instead of
      // scattering throughout already-visible ones. `folder` always sorts
      // first so folders keep coming before files, matching this
      // component's own unconditional folders-first comparator in
      // `driveItems` below. `quotaBytesUsed` is Drive's closest equivalent
      // to file size -- for real audio files (not Google-native Docs/Sheets,
      // which this folder's own query already excludes) it equals the
      // actual file size. This only affects the ORDER results arrive in;
      // the existing client-side sort in `driveItems` still runs unchanged
      // and remains the source of truth for what's actually displayed, so
      // this cannot make sorting incorrect -- only reduces how much
      // reshuffling happens while a big folder is still loading. Source:
      // Drive API v3 files.list `orderBy` docs (developers.google.com/
      // workspace/drive/api/reference/rest/v3/files/list).
      const driveOrderBy = (() => {
        switch (sortOption) {
          case 'name desc': return 'folder,name_natural desc';
          case 'modifiedTime': return 'folder,modifiedTime';
          case 'modifiedTime desc': return 'folder,modifiedTime desc';
          case 'size': return 'folder,quotaBytesUsed';
          case 'size desc': return 'folder,quotaBytesUsed desc';
          case 'name':
          default: return 'folder,name_natural';
        }
      })();

      let pageToken: string | undefined = undefined;
      let allFiles: any[] = [];
      // Files from page 2 onward are buffered and written in ONE bulkPut
      // after the loop, instead of once per page (see below) -- a folder
      // large enough to need multiple Drive API pages (>1000 audio files)
      // used to call `db.files.bulkPut()` once per page, and since
      // `dbFiles` (App.tsx) is a `useLiveQuery`, EVERY one of those writes
      // re-fires the live query, which re-sorts the FULL accumulated set
      // from scratch (driveItems' useMemo depends on `dbFiles`) and
      // re-renders the whole list. Because Drive doesn't return pages in
      // this app's own sort order, a later page's items can sort ahead of
      // earlier ones -- so which items land on the currently-viewed UI
      // page could keep changing as more pages arrive, which (a) visibly
      // reshuffles/flickers what the user is looking at, and (b) fires a
      // FRESH `get_local_metadata_batch` IPC call for whatever newly-shows-
      // up-as-"new" items land on the current page each time (see
      // MainContent.tsx's tag-lookup effect). For an N-page folder this
      // meant up to N full re-sorts/re-renders and up to N separate DB
      // round-trips instead of a bounded, small number. Page 1 is still
      // written immediately below so a fresh (previously-empty) folder
      // still shows results quickly instead of waiting for every page.
      let laterPagesFiles: any[] = [];
      let isFirstPage = true;

      do {
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent(driveOrderBy)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)&pageSize=1000` + (pageToken ? `&pageToken=${pageToken}` : '');
        // driveFetch (not the raw fetchWithAuth this loop used before) --
        // this is the single most-frequently-hit Drive API call in the
        // whole app (every folder open), and it was the ONE call site
        // with no protection against transient 429/5xx responses: any
        // rate-limit or server hiccup mid-fetch used to abort this loop
        // immediately (see the `break` below), silently truncating the
        // folder listing with no retry, while nearly every OTHER Drive
        // operation in driveApi.ts already retries 429/5xx with backoff
        // via this same driveFetch. The always-running background full-
        // library sync (proSync.worker.ts, starts right after login) also
        // calls the Drive API in a tight per-page loop with no pacing of
        // its own, which makes it more plausible for this specific,
        // heavily-hit call to occasionally land on a rate-limited window.
        const response = await driveFetch(url, { headers: { Authorization: `Bearer ${token}` } });

        if (!response.ok) {
          console.error(`[${APP_MODULE}] Failed to fetch page from drive API`, response.status);
          fetchCompleted = false;
          break;
        }

        const data = await response.json();
        if (data.files && data.files.length > 0) {
          const filesToInsert = data.files.map((file: any) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            parentId: folderId,
            size: (() => {
              const parsed = file.size ? parseInt(file.size, 10) : NaN;
              return Number.isFinite(parsed) ? parsed : undefined;
            })(),
            modifiedTime: file.modifiedTime,
            trashed: false,
            isFolder: file.mimeType === "application/vnd.google-apps.folder"
          }));

          if (isFirstPage) {
            await db.files.bulkPut(filesToInsert);
          } else {
            laterPagesFiles = laterPagesFiles.concat(filesToInsert);
          }
          allFiles = allFiles.concat(filesToInsert);
        }

        pageToken = data.nextPageToken;

        // Hide loading spinner early only if THIS request is still the latest one
        if (isFirstPage && pageToken && existingCount === 0 && folderFetchGuard.isLatest(myId)) {
          setIsLoadingTracks(false);
        }
        isFirstPage = false;

      } while (pageToken);

      // Single coalesced write for every page after the first -- caps the
      // live-query-driven re-sort/re-render/re-lookup cascade described
      // above to at most one EXTRA occurrence, regardless of how many
      // total Drive pages this folder needed (was: one occurrence PER
      // page). No-op (0-length bulkPut is skipped) for the common
      // single-page-folder case, so this changes nothing there.
      if (laterPagesFiles.length > 0) {
        await db.files.bulkPut(laterPagesFiles);
      }

      // Sync deletions: remove local files that are no longer in Google Drive.
      // Only run when the folder was fully and successfully fetched — never
      // after a failed page, otherwise we would wipe the whole folder.
      if (fetchCompleted && !pageToken && folderFetchGuard.isLatest(myId)) {
        const fetchedIds = new Set(allFiles.map((f: any) => f.id));
        const localFiles = await db.files.where('parentId').equals(folderId).toArray();
        const idsToDelete = localFiles
          .filter(f => !fetchedIds.has(f.id))
          .map(f => f.id);
          
        if (idsToDelete.length > 0) {
          await db.files.bulkDelete(idsToDelete);
        }
      }
    } catch (error) {
      console.error(`[${APP_MODULE}] Failed to fetch folder contents on demand:`, classifyAppError(error));
      fetchCompleted = false;
    } finally {
      if (folderFetchGuard.isLatest(myId)) {
        setIsLoadingTracks(false);
      }
    }
  }

  useEffect(() => {
    if (isLoggedIn && accessToken && currentFolderId) {
      fetchFolderContentsToDexie(accessToken, currentFolderId);
    }
  }, [isLoggedIn, accessToken, currentFolderId]);

  useEffect(() => {
    const handleSyncComplete = () => setIsLoadingTracks(false);
    // A failed background sync must clear the loading state too -- otherwise
    // a first-sync failure (e.g. offline, repeated 401s) would leave this
    // stuck true forever, since previously nothing but 'pro-sync-complete'
    // ever cleared it and the worker could fail without ever sending that.
    const handleSyncError = () => setIsLoadingTracks(false);

    window.addEventListener('pro-sync-complete', handleSyncComplete);
    window.addEventListener('pro-sync-error', handleSyncError);

    return () => {
      window.removeEventListener('pro-sync-complete', handleSyncComplete);
      window.removeEventListener('pro-sync-error', handleSyncError);
    };
  }, []);



  const handleTabChange = useCallback((tab: string) => {
      if (activeTab === tab && tab === "My Drive") {
        setCurrentFolderId(appRootFolder || "root");
        setCurrentFolderName("My Drive");
        setFolderHistory([]);
      }
      setActiveTab(tab);
    }, [activeTab, appRootFolder]);

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
            initialFolderId={'root'}
            initialFolderHistory={[]}
            allowEscapeRoot={true}
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

          <div id="content-area" className="flex-1 relative overflow-hidden flex flex-col">
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-500">Loading...</div>}>
              {activeTab === "Home" ? (
                <HomeTab 
                  onPlay={(t: Track, c?: Track[]) => handlePlayTrack(t, c)} 
                  onOpenFolder={(id, name) => {
                    handleOpenFolder(id, name);
                    handleTabChange("My Drive");
                  }}
                  token={accessToken} 
                  userProfile={userProfile} 
                />
              ) : activeTab === "My Drive" ? (
                <MainContent
                  activeTab={activeTab}
                  onPlay={(t: Track, c?: Track[]) => { handlePlayTrack(t, c); }}
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
                  onRemoveItem={() => { /* useLiveQuery handles UI updates automatically now */ }}
                  sortOption={sortOption}
                  onSortChange={(val) => {
                    setSortOption(val);
                    localStorage.setItem("drplay_sort_option", val);
                  }}
                />
              ) : activeTab === "Liked Songs" ? (
                <LikedSongs onPlay={(t: Track, c: Track[]) => { handlePlayTrack(t, c); }} currentTrack={currentTrack} />
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
                  minimizeToTray={minimizeToTray}
                  setMinimizeToTray={setMinimizeToTray}
                  setShowFolderSelection={setShowFolderSelection}
                  setShowTrashScreen={setShowTrashScreen}
                />
              ) : (
                <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto flex items-center justify-center transition-colors duration-300">
                  <h1 className="text-2xl text-gray-500">Coming Soon: {activeTab}</h1>
                </main>
              )}
            </Suspense>

            <PlayerBar
              currentTrack={currentTrack}
              loadNonce={loadNonce}
              isPlaying={isPlaying}
              onTogglePlay={stableHandleTogglePlay}
              onNextTrack={stableHandleNextTrack}
              onPrevTrack={stableHandlePrevTrack}
              isDownloading={isDownloading}
              playMode={playMode}
              onTogglePlayMode={stableHandleTogglePlayMode}
            />
          </div>
        </div>

        {showRateLimitModal && (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center backdrop-blur-md bg-black/30 dark:bg-black/50 transition-all duration-300">
            <div className="bg-white dark:bg-[#1f2024] p-6 sm:p-8 rounded-2xl shadow-2xl max-w-sm w-full mx-4 border border-gray-100 dark:border-gray-800 animate-in fade-in zoom-in-95">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4 text-center">
                {t('rate_limit_title', 'Nghỉ ngơi chút nhé!')}
              </h3>
              <p className="text-gray-600 dark:text-gray-300 text-center mb-6 leading-relaxed">
                {t('rate_limit_greeting', 'Hôm nay bạn đã hoạt động nhiều rồi, hãy nghỉ ngơi 1 chút nhé!')}
              </p>
              <div className="flex justify-center gap-3">
                <button
                  onClick={() => setShowRateLimitModal(false)}
                  className="px-5 py-2.5 rounded-full text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 font-medium transition-colors"
                >
                  {t('cancel', 'Hủy')}
                </button>
                <button
                  onClick={() => {
                    setShowRateLimitModal(false);
                    handleTabChange("Home");
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="px-5 py-2.5 rounded-full text-white bg-[#4285F4] hover:bg-blue-600 font-medium transition-colors shadow-md shadow-blue-500/20"
                >
                  {t('ok', 'OK')}
                </button>
              </div>
            </div>
          </div>
        )}
        
        {/* Unfocused Overlay */}
        {!isFocused && (
          <div className="fixed inset-0 z-[10001] bg-black/10 dark:bg-black/30 pointer-events-none transition-opacity duration-300" />
        )}

        <div id="toast-root" />
      </div>
    );
  }
  export default App;
