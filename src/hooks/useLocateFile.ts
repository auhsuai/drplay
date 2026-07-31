import { useEffect, useRef, useState } from 'react';
import { db } from '../db/db';
import { fetchWithAuth } from '../utils/apiClient';
import { captureError } from '../utils/errorLog';

const HISTORY_LIMIT = 20;
const HIGHLIGHT_DURATION_MS = 5000;
const ROOT_FOLDER_ID = 'root';
const MY_DRIVE_LABEL = 'My Drive';
const DRIVE_ID_PREFIX = 'drive_';
const EVENT_LOCATE_FILE = 'locate-file';
const STORAGE_KEY_ROOT = 'drplay_root_folder';
const UNKNOWN_FOLDER = 'Unknown Folder';

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

export function useLocateFile(
  accessToken: string | null,
  currentFolderId: string,
  setCurrentFolderId: (id: string) => void,
  setCurrentFolderName: (name: string) => void,
  setFolderHistory: (history: { id: string, name: string }[]) => void,
  setActiveTab: (tab: string) => void,
  setIsLoadingTracks: (loading: boolean) => void
) {
  const [highlightedFileId, setHighlightedFileId] = useState<{ id: string, ts: number } | null>(null);
  const pendingEnsuredFileId = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const handleLocateFile = async (ev: Event) => {
      let fileId = (ev as CustomEvent<{ fileId: string }>).detail?.fileId;
      if (!fileId || !accessToken) return;
      
      if (fileId.startsWith(DRIVE_ID_PREFIX)) {
        fileId = fileId.replace(DRIVE_ID_PREFIX, '');
      }

      const rebuildHistory = async (targetFolderId: string): Promise<{ id: string, name: string }[]> => {
        const rootRaw = localStorage.getItem(STORAGE_KEY_ROOT);
        const rootId = rootRaw || ROOT_FOLDER_ID;
        
        let current = targetFolderId;
        const newHistory: { id: string, name: string }[] = [];
        let limit = HISTORY_LIMIT; 
        
        while (current !== rootId && current !== ROOT_FOLDER_ID && limit > 0) {
          limit--;
          
          let pId: string | undefined;
          const folderInfo = await db.files.get(current);
          
          if (!folderInfo || !folderInfo.parentId) {
            try {
              const res = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${current}?fields=parents`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (res.ok) {
                const data = await res.json();
                if (data.parents && data.parents.length > 0) {
                  pId = data.parents[0];
                }
              }
            } catch (e: unknown) {
              captureError({ level: 'warn', source: 'useLocateFile', message: `Failed to get parents via API: ${classifyAppError(e)}` });
            }
            if (!pId) break;
          } else {
            pId = folderInfo.parentId;
          }

          if (pId === rootId || pId === ROOT_FOLDER_ID) {
            newHistory.unshift({ id: pId, name: MY_DRIVE_LABEL });
            break;
          }

          const parentInfo = await db.files.get(pId);
          if (!parentInfo) {
            try {
              const pRes = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${pId}?fields=name`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (pRes.ok) {
                const pData = await pRes.json();
                newHistory.unshift({ id: pId, name: pData.name });
              } else {
                newHistory.unshift({ id: pId, name: UNKNOWN_FOLDER });
              }
            } catch (e: unknown) {
              captureError({ level: 'warn', source: 'useLocateFile', message: `Parent name fetch failed: ${classifyAppError(e)}` });
              newHistory.unshift({ id: pId, name: UNKNOWN_FOLDER });
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
        let folderName = UNKNOWN_FOLDER;
        
        try {
          const response = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (response.ok) {
            const data = await response.json();
            if (!mounted) return;
            if (data.parents && data.parents.length > 0) {
              parentId = data.parents[0];
            }
          }
        } catch (e: unknown) {
          captureError({ level: 'warn', source: 'useLocateFile', message: `Locate parent API failed: ${classifyAppError(e)}` });
        }

        if (!parentId) {
          const fileInfo = await db.files.get(fileId);
          if (!mounted) return;
          if (fileInfo && fileInfo.parentId) {
            parentId = fileInfo.parentId;
          }
        }
        
        if (!parentId) throw new Error("Could not determine parent folder");
        
        const rootRaw = localStorage.getItem(STORAGE_KEY_ROOT);
        const rootId = rootRaw || ROOT_FOLDER_ID;
        
        if (parentId === rootId || parentId === ROOT_FOLDER_ID) {
          folderName = MY_DRIVE_LABEL;
        } else {
          const parentInfo = await db.files.get(parentId);
          if (!mounted) return;
          if (parentInfo) {
            folderName = parentInfo.name;
          } else {
             const pRes = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${parentId}?fields=name`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (pRes.ok) {
                const pData = await pRes.json();
                if (!mounted) return;
                folderName = pData.name;
              }
          }
        }

        if (parentId === currentFolderId) {
          setHighlightedFileId({ id: fileId, ts: Date.now() });
          setTimeout(() => setHighlightedFileId(null), HIGHLIGHT_DURATION_MS);
          return;
        }

        const newHistory = await rebuildHistory(parentId);
        if (!mounted) return;
        
        setFolderHistory(newHistory);
        pendingEnsuredFileId.current = fileId;
        setCurrentFolderId(parentId);
        setCurrentFolderName(folderName);
        setHighlightedFileId({id: fileId, ts: Date.now()});

        setTimeout(() => setHighlightedFileId(null), HIGHLIGHT_DURATION_MS);
      } catch (err: unknown) {
        captureError({ level: 'error', source: 'useLocateFile', message: `Locate file failed: ${classifyAppError(err)}` });
      } finally {
        if (mounted) setIsLoadingTracks(false);
      }
    };

    window.addEventListener(EVENT_LOCATE_FILE, handleLocateFile);
    return () => {
      mounted = false;
      window.removeEventListener(EVENT_LOCATE_FILE, handleLocateFile);
    };
  }, [accessToken, currentFolderId, setActiveTab, setCurrentFolderId, setCurrentFolderName, setFolderHistory, setIsLoadingTracks]);

  return { highlightedFileId, pendingEnsuredFileId };
}
