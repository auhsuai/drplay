import { useEffect, useRef, useState } from 'react';
import { db } from '../db/db';
import { fetchWithAuth } from '../utils/apiClient';

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
              const res = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${current}?fields=parents`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (res.ok) {
                const data = await res.json();
                if (data.parents && data.parents.length > 0) {
                  pId = data.parents[0];
                }
              }
            } catch (e) {
              console.warn(`[useLocateFile] Failed to get parents via API`, classifyAppError(e));
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
              const pRes = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${pId}?fields=name`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (pRes.ok) {
                const pData = await pRes.json();
                newHistory.unshift({ id: pId, name: pData.name });
              } else {
                newHistory.unshift({ id: pId, name: "Unknown Folder" });
              }
            } catch (e) {
              console.warn(`[useLocateFile] parent-name-fetch-failed`, classifyAppError(e));
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
        
        try {
          const response = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (response.ok) {
            const data = await response.json();
            if (data.parents && data.parents.length > 0) {
              parentId = data.parents[0];
            }
          }
        } catch (e) {
          console.warn(`[useLocateFile] locate-parent-api-failed`, classifyAppError(e));
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
             const pRes = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${parentId}?fields=name`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (pRes.ok) {
                const pData = await pRes.json();
                folderName = pData.name;
              }
          }
        }

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
        console.error(`[useLocateFile] Locate file failed`, classifyAppError(err));
      } finally {
        setIsLoadingTracks(false);
      }
    };

    window.addEventListener('locate-file', handleLocateFile);
    return () => window.removeEventListener('locate-file', handleLocateFile);
  }, [accessToken, currentFolderId, setActiveTab, setCurrentFolderId, setCurrentFolderName, setFolderHistory, setIsLoadingTracks]);

  return { highlightedFileId, pendingEnsuredFileId };
}
