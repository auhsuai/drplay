import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Download, FolderOutput, Trash2, Loader2, Search, CheckCircle2, Music, ChevronRight, CheckSquare, ChevronLeft, X, MapPin } from "lucide-react";
import { Track, DriveItem } from "../../App";
import { getPlaylists, addTrackToPlaylist, Playlist } from "../../utils/playlists";
import { deleteFile, moveFile } from "../../utils/driveApi";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { useTranslation } from "react-i18next";
import { getValidToken } from "../../utils/apiClient";
import { getEffectiveDownloadPath } from "../../utils/downloadPath";
import { db } from "../../db/db";
import { showErrorToast } from "../../utils/simpleToast";
import { useClickOutside } from "../../hooks/useClickOutside";

interface MoreMenuProps {
  track?: Track;
  driveItem?: DriveItem;
  token?: string | null;
  currentFolderId?: string;
  currentFolderName?: string;
  folderHistory?: {id: string, name: string}[];
  onRefresh?: () => void;
  onRemoveItem?: (id: string) => void;
  forceOpen?: boolean;
  onClose?: () => void;
  anchorPoint?: { x: number, y: number } | null;
  onOpenChange?: (isOpen: boolean) => void;
  onSelectMultiple?: () => void;
  isPlayerBarMode?: boolean;
  isBulkSelected?: boolean;
  onBulkMoveClick?: () => void;
  onBulkDeleteClick?: () => void;
}

export function MoreMenu({ track, driveItem, token, currentFolderId, currentFolderName, folderHistory, onRefresh, onRemoveItem, forceOpen, onClose, anchorPoint, onOpenChange, onSelectMultiple, isPlayerBarMode, isBulkSelected, onBulkMoveClick, onBulkDeleteClick }: MoreMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [showPlaylistsSubmenu, setShowPlaylistsSubmenu] = useState(false);
  const [playlistSearchQuery, setPlaylistSearchQuery] = useState('');
  const [playlistCurrentPage, setPlaylistCurrentPage] = useState(1);
  const [playlistSubmenuOpenLeft, setPlaylistSubmenuOpenLeft] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const [openUpwards, setOpenUpwards] = useState(true);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  const isMenuOpen = isOpen || forceOpen;

  const getContextMenuStyle = (): React.CSSProperties | undefined => {
    if (anchorPoint) {
      const style: React.CSSProperties = {};
      if (anchorPoint.x > window.innerWidth / 2) {
        style.right = window.innerWidth - anchorPoint.x;
      } else {
        style.left = anchorPoint.x;
      }
      if (anchorPoint.y > window.innerHeight / 2) {
        style.bottom = window.innerHeight - anchorPoint.y;
      } else {
        style.top = anchorPoint.y;
      }
      return style;
    }

    if (buttonRect) {
      const style: React.CSSProperties = {};
      style.right = window.innerWidth - buttonRect.right;
      
      if (openUpwards) {
        style.bottom = window.innerHeight - buttonRect.top + 8;
      } else {
        style.top = buttonRect.bottom + 8;
      }
      return style;
    }
    
    return undefined;
  };

  useEffect(() => {
    if (isMenuOpen) {
      getPlaylists().then(setPlaylists).catch(err => console.error('[MoreMenu] Failed to load playlists', err));
    } else {
      setShowPlaylistsSubmenu(false);
    }
  }, [isMenuOpen]);

  useEffect(() => {
    if (!showPlaylistsSubmenu) {
      setPlaylistSearchQuery("");
      setPlaylistCurrentPage(1);
    }
  }, [showPlaylistsSubmenu]);

  // Closing on an outside click was previously a hand-rolled mousedown
  // listener here (duplicating the same pattern already consolidated into
  // useClickOutside for LanguageDropdown/ThemeDropdown/TrashScreen). The
  // trigger button (menuRef) and the dropdown panel (dropdownRef) are two
  // separate elements — a click landing on either must NOT close the menu —
  // which is exactly what useClickOutside's multi-ref support is for.
  useClickOutside([menuRef, dropdownRef], !!isMenuOpen, () => {
    setIsOpen(false);
    setShowPlaylistsSubmenu(false);
    onClose?.();
  });

  // Closing on scroll is a distinct behavior (not "click outside") specific
  // to this menu's absolutely-positioned panel, which can't follow its
  // trigger button if an ancestor scrolls — kept as its own effect.
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleScroll = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) {
        return;
      }
      setIsOpen(false);
      setShowPlaylistsSubmenu(false);
      onClose?.();
    };
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [isMenuOpen, onClose]);

  const handleAddToPlaylist = async (e: React.MouseEvent, playlistId: string) => {
    e.stopPropagation();
    if (track) {
      try {
        await addTrackToPlaylist(playlistId, track);
        setIsOpen(false);
        onClose?.();
      } catch (err) {
        console.error("[MoreMenu] add-to-playlist: Failed to add track to playlist", err);
        showErrorToast(t('menu.add_to_playlist_error') || "Failed to add to playlist");
      }
    }
  };

  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMoveScreen, setShowMoveScreen] = useState(false);

  const handleDelete = async () => {
    if (!driveItem || !token) return;
    setIsDeleting(true);
    try {
      await deleteFile(token, driveItem.id);
      await db.files.delete(driveItem.id); // Also remove from local DB
      setShowDeleteConfirm(false);
      setIsOpen(false);
      onClose?.();
      if (onRemoveItem) onRemoveItem(driveItem.id);
      else if (onRefresh) onRefresh();
    } catch (e) {
      console.error("[MoreMenu] delete: Failed to delete item", e);
      showErrorToast(t('drive.delete_error') || "Failed to delete item");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMove = async (newParentId: string) => {
    if (!driveItem || !token || !currentFolderId) return;
    
    if (newParentId === currentFolderId) {
      setShowMoveScreen(false);
      setIsOpen(false);
      onClose?.();
      return;
    }

    const itemId = driveItem.id;
    const oldParentId = currentFolderId;

    setShowMoveScreen(false);
    setIsOpen(false);
    onClose?.();

    try {
      await moveFile(token, itemId, oldParentId, newParentId);
      await db.files.update(itemId, { parentId: newParentId });
      if (onRemoveItem) onRemoveItem(itemId);
    } catch (e) {
      console.error("[MoreMenu] move: Failed to move item", e);
      showErrorToast(t('drive.move_error') || "Failed to move item");
      if (onRefresh) onRefresh();
    }
  };

  const [isDownloadingFile, setIsDownloadingFile] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [downloadFileName, setDownloadFileName] = useState("");
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);

  useEffect(() => {
    if (downloadMessage) {
      const timer = setTimeout(() => setDownloadMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [downloadMessage]);

  const handleDownloadClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!track) return;
    setDownloadFileName(track.title);
    setShowDownloadDialog(true);
    setIsOpen(false);
  };

  const executeDownload = async () => {
    if (isDownloadingFile) return;
    setIsDownloadingFile(true);
    setShowDownloadDialog(false);
    
    try {
      const freshToken = await getValidToken();
      if (!freshToken) throw new Error("No valid token");

      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${track?.id}?alt=media`;
      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${freshToken}`
        }
      });
      
      if (!response.ok) throw new Error("Fetch failed");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      const base = downloadFileName.trim() || 'audio';
      const ext = track?.originalName?.includes('.') ? track.originalName.slice(track.originalName.lastIndexOf('.')) : '.mp3';
      const finalFileName = `${base}${ext}`;
      a.download = finalFileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      try {
        const dir = await getEffectiveDownloadPath();
        setDownloadMessage(`${t('menu.saved_at', 'Đã lưu tại:')} ${dir}\\${finalFileName}`);
      } catch (e) {
        setDownloadMessage(t('menu.download_complete', 'Tải xuống hoàn tất!'));
      }
    } catch (err) {
      console.error('[MoreMenu] download: Failed to download file', err);
      setDownloadMessage(t('menu.download_failed', 'Tải xuống thất bại'));
    } finally {
      setIsDownloadingFile(false);
    }
  };


  const renderMenuContent = () => (
    <>
      {isPlayerBarMode ? (
        <>
          {track && (
            <>
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  handleDownloadClick(e);
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('menu.download_song', 'Download Song')}</span>
              </button>
              
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  window.dispatchEvent(new CustomEvent('locate-file', { 
                    detail: { 
                      fileId: track.id,
                      parentId: track.parentId,
                      parentName: track.parentName
                    } 
                  }));
                  setIsOpen(false); 
                  onClose?.();
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1"
              >
                <MapPin className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('menu.navigate', 'Navigate')}</span>
              </button>
            </>
          )}
        </>
      ) : (
        <>
          {driveItem && token && (
            <>
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  setIsOpen(false); 
                  onClose?.();
                  onSelectMultiple?.();
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1"
              >
                <CheckSquare className="w-4 h-4 text-gray-400 group-hover:text-[#4285F4]" />
                {t('menu.select_multiple', 'Đa chọn')}
              </button>
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  if (isBulkSelected && onBulkMoveClick) {
                    setIsOpen(false);
                    onClose?.();
                    onBulkMoveClick();
                  } else {
                    setShowMoveScreen(true); 
                    setIsOpen(false); 
                    onClose?.(); 
                  }
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1"
              >
                <FolderOutput className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('drive.move_to') || 'Move to...'}</span>
              </button>
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  if (isBulkSelected && onBulkDeleteClick) {
                    setIsOpen(false);
                    onClose?.();
                    onBulkDeleteClick();
                  } else {
                    setShowDeleteConfirm(true); 
                    setIsOpen(false); 
                    onClose?.(); 
                  }
                }}
                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all flex items-center gap-2 group mb-1"
              >
                <Trash2 className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('drive.delete') || 'Delete'}</span>
              </button>
            </>
          )}

          {track && (
            <button
              onClick={handleDownloadClick}
              className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
              <span className="truncate">{t('menu.download')}</span>
            </button>
          )}
        </>
      )}
          
          {track && (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const btn = e.currentTarget;
                  const rect = btn.getBoundingClientRect();
                  setPlaylistSubmenuOpenLeft(rect.right + 270 > window.innerWidth);
                  setShowPlaylistsSubmenu(!showPlaylistsSubmenu);
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center justify-between group mb-1"
              >
                <div className="flex items-center gap-2">
                  <Music className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                  <span className="truncate">{t('menu.add_to_playlist')}</span>
                </div>
                <ChevronRight className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
              </button>

              {showPlaylistsSubmenu && (() => {
                const filteredPlaylists = playlists.filter(p => p.name.toLowerCase().includes(playlistSearchQuery.toLowerCase()));
                const playlistsPerPage = 5;
                const playlistTotalPages = Math.max(1, Math.ceil(filteredPlaylists.length / playlistsPerPage));
                const currentPlaylists = filteredPlaylists.slice((playlistCurrentPage - 1) * playlistsPerPage, playlistCurrentPage * playlistsPerPage);

                return (
                  <div className={`absolute bottom-0 ${playlistSubmenuOpenLeft ? 'right-full mr-3' : 'left-full ml-3'} w-64 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 z-50 flex flex-col animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none`}>
                    <div className="px-3 py-2 flex items-center justify-between gap-2">
                      <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                        {t('sidebar.playlists', 'Playlists')}
                      </div>
                      
                      <div className="relative flex-1 max-w-[120px]">
                        <Search className="w-3 h-3 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          placeholder={t('search_placeholder', 'Search...')}
                          value={playlistSearchQuery}
                          onChange={(e) => {
                            setPlaylistSearchQuery(e.target.value);
                            setPlaylistCurrentPage(1);
                          }}
                          className="w-full pl-6 pr-2 py-1 text-[10px] bg-gray-100 dark:bg-[#1c1d21] hover:bg-gray-200 dark:hover:bg-[#25262a] focus:bg-gray-200 dark:focus:bg-[#25262a] text-gray-900 dark:text-gray-100 rounded outline-none transition-all placeholder:text-gray-500"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-0.5">
                      {filteredPlaylists.length === 0 ? (
                        <div className="px-3 py-3 text-sm text-gray-400 text-center italic">
                          {t('menu.no_playlists')}
                        </div>
                      ) : (
                        currentPlaylists.map(p => (
                          <button
                            key={p.id}
                            onClick={(e) => handleAddToPlaylist(e, p.id)}
                            className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group"
                          >
                            <Music className="w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity" />
                            <span className="truncate">{p.name}</span>
                          </button>
                        ))
                      )}
                    </div>

                    {playlistTotalPages > 1 && (
                      <div className="px-2 pt-2 pb-1 mt-1 border-t border-gray-100 dark:border-gray-800/60 flex items-center justify-center gap-4">
                        <button
                          onClick={(e) => { e.stopPropagation(); setPlaylistCurrentPage(prev => Math.max(1, prev - 1)); }}
                          disabled={playlistCurrentPage === 1}
                          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-30 transition-colors"
                        >
                          <ChevronLeft className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                        </button>
                        <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                          {playlistCurrentPage} / {playlistTotalPages}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); setPlaylistCurrentPage(prev => Math.min(playlistTotalPages, prev + 1)); }}
                          disabled={playlistCurrentPage === playlistTotalPages}
                          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#33343a] disabled:opacity-30 transition-colors"
                        >
                          <ChevronRight className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
    </>
  );

  return (
    <div className="relative" ref={menuRef} onClick={e => e.stopPropagation()}>
      <button 
        onClick={(e) => { 
          if (!isDownloadingFile) { 
            e.stopPropagation(); 
            if (!isOpen) {
              const rect = e.currentTarget.getBoundingClientRect();
              setButtonRect(rect);
              setOpenUpwards(rect.bottom + 250 > window.innerHeight);
            }
            setIsOpen(!isOpen); 
          } 
        }}
        disabled={isDownloadingFile}
        className={`relative p-2 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-[#4285F4]/40 ${isDownloadingFile ? 'cursor-default opacity-50' : 'text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a]'}`}
      >
        {isDownloadingFile ? (
          <Loader2 className="w-5 h-5 animate-spin text-[#4285F4]" />
        ) : (
          <MoreHorizontal className="w-5 h-5" />
        )}
      </button>

      {isMenuOpen && createPortal(
        <div 
          ref={dropdownRef}
          className={`fixed z-[9999] w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 flex flex-col transition-all animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none ${anchorPoint ? '' : (openUpwards ? 'origin-bottom-right' : 'origin-top-right')}`}
          style={getContextMenuStyle()}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => { e.stopPropagation(); e.preventDefault(); }}
        >
          {renderMenuContent()}
        </div>,
        document.body
      )}

      {showDownloadDialog && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={e => e.stopPropagation()}>
          <div className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{t('menu.download_title')}</h3>
              <button 
                onClick={() => !isDownloadingFile && setShowDownloadDialog(false)}
                disabled={isDownloadingFile}
                className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-1 rounded-full transition-colors disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('menu.file_name')}
              </label>
              <input
                type="text"
                value={downloadFileName}
                onChange={(e) => setDownloadFileName(e.target.value)}
                disabled={isDownloadingFile}
                className="w-full bg-gray-100 dark:bg-[#25262a] hover:bg-gray-200/70 dark:hover:bg-[#2c2d32] focus:bg-gray-200 dark:focus:bg-[#2c2d32] text-gray-900 dark:text-white text-sm rounded-xl px-4 py-3 outline-none transition-all duration-300 placeholder:text-gray-400 dark:placeholder:text-gray-500"
                placeholder={t('menu.file_name')}
                autoFocus
              />
            </div>
            
            <div className="flex items-center justify-end gap-3 mt-2">
              <button
                onClick={() => setShowDownloadDialog(false)}
                disabled={isDownloadingFile}
                className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
              >
                {t('menu.cancel')}
              </button>
              <button
                onClick={executeDownload}
                disabled={isDownloadingFile || !downloadFileName.trim()}
                className="px-5 py-2.5 text-sm font-medium text-white bg-[#4285F4] hover:bg-blue-600 rounded-xl shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/30 transition-all flex items-center gap-2 disabled:opacity-50"
              >
                {isDownloadingFile ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span>{isDownloadingFile ? t('menu.downloading') : t('menu.confirm_download')}</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Toast Notification */}
      {downloadMessage && createPortal(
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] animate-in slide-in-from-bottom-5 fade-in duration-300 w-full max-w-[90vw] md:max-w-md pointer-events-none">
          <div className="bg-white dark:bg-[#2a2b2f] text-gray-900 dark:text-white shadow-xl shadow-black/10 dark:shadow-black/30 rounded-full px-5 py-3 flex items-center gap-3">
            <div className="w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
            </div>
            <p className="text-sm font-medium truncate" title={downloadMessage}>{downloadMessage}</p>
          </div>
        </div>,
        document.body
      )}

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={() => !isDeleting && setShowDeleteConfirm(false)}>
          <div className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 w-full max-w-sm shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <div className="flex flex-col gap-2">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                {t('drive.confirm_delete') || 'Move to Trash?'}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {driveItem?.title}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 mt-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors disabled:opacity-50"
              >
                {t('menu.cancel') || 'Cancel'}
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-xl shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
              >
                {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                <span>{t('drive.delete') || 'Delete'}</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Move Folder Selection Screen */}
      {showMoveScreen && token && createPortal(
        <FolderSelectionScreen
          token={token}
          onSelectFolder={handleMove}
          onCancel={() => setShowMoveScreen(false)}
          initialFolderId={currentFolderId || 'root'}
          initialFolderName={currentFolderName}
          initialFolderHistory={folderHistory}
          title={t('drive.move_to') || 'Move to...'}
          subtitle={`${t('drive.move_item_desc') || 'Select destination for'} ${driveItem?.title}`}
        />,
        document.body
      )}
    </div>
  );
}
