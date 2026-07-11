import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Music, Download, X, CheckCircle2, Trash2, FolderOutput, CheckSquare } from "lucide-react";

import { Track, DriveItem } from "../../App";
import { getPlaylists, addTrackToPlaylist, Playlist } from "../../utils/playlists";
import { deleteFile, moveFile } from "../../utils/driveApi";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { useTranslation } from "react-i18next";
import { getEffectiveDownloadPath } from "../../utils/downloadPath";
import { db } from "../../db/db";

export interface ContextMenuData {
  x: number;
  y: number;
  track?: Track;
  driveItem?: DriveItem;
  currentFolderId?: string;
  onRefresh?: () => void;
  onRemoveItem?: (id: string) => void;
}

export function GlobalContextMenu() {
  const { t } = useTranslation();
  const [data, setData] = useState<ContextMenuData | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  // States for sub-dialogs
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  
  const [downloadingState, setDownloadingState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');

  useEffect(() => {
    const handleContextMenu = (e: CustomEvent<ContextMenuData>) => {
      setData(e.detail);
      setShowMoveDialog(false);
      setShowDeleteConfirm(false);
    };
    
    const handleClose = () => setData(null);

    window.addEventListener("show-context-menu" as any, handleContextMenu);
    window.addEventListener("click", handleClose);
    window.addEventListener("scroll", handleClose);

    return () => {
      window.removeEventListener("show-context-menu" as any, handleContextMenu);
      window.removeEventListener("click", handleClose);
      window.removeEventListener("scroll", handleClose);
    };
  }, []);

  useEffect(() => {
    if (data) {
      getPlaylists().then(setPlaylists).catch(console.error);
    }
  }, [data]);

  if (!data) return null;

  const { x, y, track, driveItem, currentFolderId, onRemoveItem } = data;

  const handleAddToPlaylist = async (e: React.MouseEvent, playlistId: string) => {
    e.stopPropagation();
    if (track) {
      await addTrackToPlaylist(playlistId, track);
      setData(null);
    }
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const token = localStorage.getItem("drplay_access_token");
    if (!driveItem || !token) return;
    
    setDownloadingState('downloading');
    try {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${driveItem.id}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error("Download failed");
      
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      const downloadDirPath = await getEffectiveDownloadPath();
      const savePath = `${downloadDirPath}\\${driveItem.title}`;
      
      await invoke("plugin:fs|write_file", { path: savePath, data: Array.from(uint8Array) });
      setDownloadingState('success');
      setTimeout(() => setDownloadingState('idle'), 3000);
      setData(null);
    } catch (error) {
      console.error("Download error:", error);
      setDownloadingState('error');
      setTimeout(() => setDownloadingState('idle'), 3000);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const token = localStorage.getItem("drplay_access_token");
    if (!driveItem || !token) return;
    setIsDeleting(true);
    try {
      await deleteFile(token, driveItem.id);
      await db.files.delete(driveItem.id);
      if (onRemoveItem) onRemoveItem(driveItem.id);
      setData(null);
    } catch (error) {
      console.error("Delete failed", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMove = async (newFolderId: string) => {
    const token = localStorage.getItem("drplay_access_token");
    if (!driveItem || !token) return;
    try {
      await moveFile(token, driveItem.id, currentFolderId || 'root', newFolderId);
      await db.files.update(driveItem.id, { parentId: newFolderId });
      if (onRemoveItem) onRemoveItem(driveItem.id);
      setData(null);
    } catch (error) {
      console.error("Move failed", error);
    }
  };

  // Adjust menu position to keep it within the screen
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 250),
    top: Math.min(y, window.innerHeight - 300),
    zIndex: 9999
  };

  return createPortal(
    <>
      <div 
        ref={menuRef}
        style={menuStyle}
        className="w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-100 dark:border-white/5 p-1.5 flex flex-col animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {track && (
          <div className="relative group/playlist">
            <button className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] rounded-md transition-all flex items-center gap-2 group/btn mb-1">
              <Music size={16} className="text-gray-400 group-hover/btn:text-[#4285F4]" />
              {t('playlist.add_to_playlist', 'Thêm vào Playlist')}
            </button>
            <div className="absolute right-full top-0 mr-1 w-48 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-100 dark:border-white/5 p-1.5 opacity-0 invisible group-hover/playlist:opacity-100 group-hover/playlist:visible transition-all duration-200 pointer-events-none group-hover/playlist:pointer-events-auto">
              {playlists.length > 0 ? (
                playlists.map(pl => (
                  <button
                    key={pl.id}
                    onClick={(e) => handleAddToPlaylist(e, pl.id)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] rounded-md transition-colors truncate"
                  >
                    {pl.name}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-sm text-gray-500 italic">
                  {t('playlist.no_playlists', 'Chưa có playlist')}
                </div>
              )}
            </div>
          </div>
        )}

        {driveItem && (
          <>
            <button
              onClick={(e) => { 
                e.stopPropagation(); 
                window.dispatchEvent(new CustomEvent('enable-selection-mode', { detail: { id: driveItem.id } }));
                setData(null); 
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group/btn mb-1"
            >
              <CheckSquare size={16} className="text-gray-400 group-hover/btn:text-[#4285F4]" />
              {t('menu.select_multiple', 'Chọn nhiều mục')}
            </button>
            
            <button
              onClick={(e) => { e.stopPropagation(); setShowMoveDialog(true); setData(null); }}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] rounded-md transition-all flex items-center gap-2 group/btn mb-1"
            >
              <FolderOutput size={16} className="text-gray-400 group-hover/btn:text-blue-500" />
              {t('common.move_to', 'Chuyển đến...')}
            </button>

            {!driveItem.isFolder && (
              <button
                onClick={handleDownload}
                disabled={downloadingState !== 'idle'}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] rounded-md transition-all flex items-center gap-2 group/btn mb-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {downloadingState === 'idle' && <Download size={16} className="text-gray-400 group-hover/btn:text-green-500" />}
                {downloadingState === 'downloading' && <div className="w-4 h-4 border-2 border-gray-400 border-t-green-500 rounded-full animate-spin" />}
                {downloadingState === 'success' && <CheckCircle2 size={16} className="text-green-500" />}
                {downloadingState === 'error' && <X size={16} className="text-red-500" />}
                {downloadingState === 'idle' ? t('common.download', 'Tải xuống') : 
                 downloadingState === 'downloading' ? t('common.downloading', 'Đang tải...') : 
                 downloadingState === 'success' ? t('common.download_success', 'Đã lưu') : 
                 t('common.download_error', 'Lỗi tải xuống')}
              </button>
            )}

            <div className="h-px bg-gray-100 dark:bg-white/5 my-1" />

            <button
              onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); setData(null); }}
              className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md transition-all flex items-center gap-2 group/btn"
            >
              <Trash2 size={16} className="text-red-500 group-hover/btn:text-red-600" />
              {t('common.delete', 'Xóa')}
            </button>
          </>
        )}
      </div>

      {showMoveDialog && driveItem && (
        <FolderSelectionScreen
          token={localStorage.getItem("drplay_access_token")!}
          onCancel={() => setShowMoveDialog(false)}
          onSelectFolder={handleMove}
          title={t('common.move_to', 'Chuyển đến...')}
        />
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1f2024] rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-500/20 flex items-center justify-center mb-4 mx-auto">
              <Trash2 size={24} className="text-red-600 dark:text-red-500" />
            </div>
            <h3 className="text-xl font-bold text-center text-gray-900 dark:text-white mb-2">
              {t('common.delete_confirm', 'Xác nhận xóa?')}
            </h3>
            <p className="text-center text-gray-500 dark:text-gray-400 mb-6">
              {t('common.delete_desc', 'Mục này sẽ được chuyển vào Thùng rác của Google Drive.')}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 px-4 py-2.5 rounded-xl text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors font-medium"
              >
                {t('common.cancel', 'Hủy')}
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex-1 px-4 py-2.5 rounded-xl text-white bg-red-600 hover:bg-red-700 transition-colors font-medium flex items-center justify-center gap-2 disabled:opacity-70"
              >
                {isDeleting && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {t('common.delete', 'Xóa')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}
