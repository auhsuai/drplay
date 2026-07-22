import { useEffect } from 'react';
import { db } from '../db/db';
import { driveFetch, classifyDriveError } from '../utils/driveApi';
import type { BreadcrumbItem } from '../App';

const APP_MODULE = 'App';

interface UseLocateFileParams {
  accessToken: string | null;
  currentFolderId: string;
  setActiveTab: (tab: string) => void;
  setIsLoadingTracks: (v: boolean) => void;
  setFolderHistory: (h: BreadcrumbItem[]) => void;
  setCurrentFolderId: (id: string) => void;
  setCurrentFolderName: (name: string) => void;
  setHighlightedFileId: (v: { id: string; ts: number } | null) => void;
}

export function useLocateFile(params: UseLocateFileParams) {
  const {
    accessToken, currentFolderId, setActiveTab, setIsLoadingTracks,
    setFolderHistory, setCurrentFolderId, setCurrentFolderName, setHighlightedFileId,
  } = params;

  useEffect(() => {
    const handleLocateFile = async (e: any) => {
      let { fileId } = e.detail || {};
      if (!fileId || !accessToken) return;

      if (fileId.startsWith('drive_')) fileId = fileId.replace('drive_', '');

      const rebuildHistory = async (targetFolderId: string): Promise<BreadcrumbItem[]> => {
        const rootId = localStorage.getItem("drplay_root_folder") || 'root';
        let current = targetFolderId;
        const newHistory: BreadcrumbItem[] = [];
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
                if (data.parents && data.parents.length > 0) pId = data.parents[0];
              }
            } catch (err) {
              console.warn(`[${APP_MODULE}] Failed to get parents via API`, classifyDriveError(err));
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
            } catch (err) {
              console.warn(`[${APP_MODULE}] parent-name-fetch-failed`, classifyDriveError(err));
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
          const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (response.ok) {
            const data = await response.json();
            if (data.parents && data.parents.length > 0) parentId = data.parents[0];
          }
        } catch (err) {
          console.warn(`[${APP_MODULE}] locate-parent-api-failed`, classifyDriveError(err));
        }
        if (!parentId) {
          const fileInfo = await db.files.get(fileId);
          if (fileInfo && fileInfo.parentId) parentId = fileInfo.parentId;
        }

        if (!parentId) throw new Error("Could not determine parent folder");

        const rootId = localStorage.getItem("drplay_root_folder") || 'root';
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
            if (pRes.ok) { const pData = await pRes.json(); folderName = pData.name; }
          }
        }

        if (parentId === currentFolderId) {
          setHighlightedFileId({ id: fileId, ts: Date.now() });
          setTimeout(() => setHighlightedFileId(null), 5000);
          return;
        }

        const newHistory = await rebuildHistory(parentId);
        setFolderHistory(newHistory);
        setCurrentFolderId(parentId);
        setCurrentFolderName(folderName);
        setHighlightedFileId({ id: fileId, ts: Date.now() });
        setTimeout(() => setHighlightedFileId(null), 5000);
      } catch (err) {
        console.error(`[${APP_MODULE}] Locate file failed`, classifyDriveError(err));
      } finally {
        setIsLoadingTracks(false);
      }
    };

    window.addEventListener('locate-file', handleLocateFile);
    return () => window.removeEventListener('locate-file', handleLocateFile);
  }, [accessToken, currentFolderId, setActiveTab, setIsLoadingTracks,
      setFolderHistory, setCurrentFolderId, setCurrentFolderName, setHighlightedFileId]);
}
