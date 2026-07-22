import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Download, FolderOutput, Trash2, Loader2, Music, ChevronRight, CheckSquare, MapPin } from "lucide-react";
import { Track, DriveItem } from "../../App";
import { getPlaylists, Playlist } from "../../utils/playlists";
import { deleteFile, moveFile } from "../../utils/driveApi";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { useTranslation } from "react-i18next";
import { db } from "../../db/db";
import { showErrorToast } from "../../utils/simpleToast";
import { useClickOutside } from "../../hooks/useClickOutside";
import { getContextMenuStyle } from "./MoreMenu/hooks/useMenuPosition";
import { useDownload } from "./MoreMenu/hooks/useDownload";
import { PlaylistSubmenu } from "./MoreMenu/PlaylistSubmenu";
import { DownloadDialog } from "./MoreMenu/DownloadDialog";
import { DeleteConfirmDialog } from "./MoreMenu/DeleteConfirmDialog";

interface MoreMenuProps {
  track?: Track; driveItem?: DriveItem; token?: string | null;
  currentFolderId?: string; currentFolderName?: string;
  folderHistory?: { id: string; name: string }[];
  onRefresh?: () => void; onRemoveItem?: (id: string) => void;
  forceOpen?: boolean; onClose?: () => void;
  anchorPoint?: { x: number; y: number } | null;
  onOpenChange?: (isOpen: boolean) => void; onSelectMultiple?: () => void;
  isPlayerBarMode?: boolean; isBulkSelected?: boolean;
  onBulkMoveClick?: () => void; onBulkDeleteClick?: () => void;
}

export function MoreMenu({
  track, driveItem, token, currentFolderId, currentFolderName, folderHistory,
  onRefresh, onRemoveItem, forceOpen, onClose, anchorPoint, onOpenChange,
  onSelectMultiple, isPlayerBarMode, isBulkSelected, onBulkMoveClick, onBulkDeleteClick,
}: MoreMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [showPlaylistsSubmenu, setShowPlaylistsSubmenu] = useState(false);
  const [playlistSubmenuOpenLeft, setPlaylistSubmenuOpenLeft] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const [openUpwards, setOpenUpwards] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMoveScreen, setShowMoveScreen] = useState(false);

  useEffect(() => { onOpenChange?.(isOpen); }, [isOpen, onOpenChange]);
  const isMenuOpen = isOpen || forceOpen;

  useClickOutside([menuRef, dropdownRef], !!isMenuOpen, () => {
    setIsOpen(false); setShowPlaylistsSubmenu(false); onClose?.();
  });

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleScroll = (e: Event) => {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        setIsOpen(false); setShowPlaylistsSubmenu(false); onClose?.();
      }
    };
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [isMenuOpen, onClose]);

  useEffect(() => {
    if (isMenuOpen) getPlaylists().then(setPlaylists).catch(() => {});
    else setShowPlaylistsSubmenu(false);
  }, [isMenuOpen]);

  const { isDownloadingFile, showDownloadDialog, setShowDownloadDialog,
    downloadFileName, setDownloadFileName, downloadMessage,
    handleDownloadClick, executeDownload } = useDownload(track);

  const handleDelete = async () => {
    if (!driveItem || !token) return;
    setIsDeleting(true);
    try {
      await deleteFile(token, driveItem.id);
      await db.files.delete(driveItem.id);
      setShowDeleteConfirm(false); setIsOpen(false); onClose?.();
      if (onRemoveItem) onRemoveItem(driveItem.id);
      else if (onRefresh) onRefresh();
    } catch {
      showErrorToast(t('drive.delete_error') || "Failed to delete item");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMove = async (newParentId: string) => {
    if (!driveItem || !token || !currentFolderId) return;
    if (newParentId === currentFolderId) { setShowMoveScreen(false); return; }
    setShowMoveScreen(false); setIsOpen(false); onClose?.();
    try {
      await moveFile(token, driveItem.id, currentFolderId, newParentId);
      await db.files.update(driveItem.id, { parentId: newParentId });
      if (onRemoveItem) onRemoveItem(driveItem.id);
    } catch {
      showErrorToast(t('drive.move_error') || "Failed to move item");
      if (onRefresh) onRefresh();
    }
  };

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
        className={`relative p-2 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-[#4285F4]/40 ${isDownloadingFile ? 'cursor-default opacity-50' : 'text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a]'}`}>
        {isDownloadingFile ? <Loader2 className="w-5 h-5 animate-spin text-[#4285F4]" /> : <MoreHorizontal className="w-5 h-5" />}
      </button>

      {isMenuOpen && createPortal(
        <div ref={dropdownRef}
          className={`fixed z-[9999] w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 flex flex-col transition-all animate-in fade-in zoom-in-95 duration-200 ${anchorPoint ? '' : (openUpwards ? 'origin-bottom-right' : 'origin-top-right')}`}
          style={getContextMenuStyle(anchorPoint, buttonRect, openUpwards)}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => { e.stopPropagation(); e.preventDefault(); }}>

          {isPlayerBarMode ? (
            track && <>
              <button onClick={(e) => { handleDownloadClick(e); setIsOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1">
                <Download className="w-4 h-4 opacity-60 group-hover:opacity-100" />
                {t('menu.download_song', 'Download Song')}
              </button>
              <button onClick={() => { window.dispatchEvent(new CustomEvent('locate-file', { detail: { fileId: track.id, parentId: track.parentId, parentName: track.parentName } })); setIsOpen(false); onClose?.(); }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1">
                <MapPin className="w-4 h-4 opacity-60 group-hover:opacity-100" />
                {t('menu.navigate', 'Navigate')}
              </button>
            </>
          ) : (
            <>
              {driveItem && token && <>
                <button onClick={() => { setIsOpen(false); onClose?.(); onSelectMultiple?.(); }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1">
                  <CheckSquare className="w-4 h-4 text-gray-400 group-hover:text-[#4285F4]" />
                  {t('menu.select_multiple', 'Đa chọn')}
                </button>
                <button onClick={() => { if (isBulkSelected && onBulkMoveClick) { setIsOpen(false); onClose?.(); onBulkMoveClick(); } else setShowMoveScreen(true); }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1">
                  <FolderOutput className="w-4 h-4 opacity-60 group-hover:opacity-100" />
                  {t('drive.move_to') || 'Move to...'}
                </button>
                <button onClick={() => { if (isBulkSelected && onBulkDeleteClick) { setIsOpen(false); onClose?.(); onBulkDeleteClick(); } else setShowDeleteConfirm(true); }}
                  className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all flex items-center gap-2 group mb-1">
                  <Trash2 className="w-4 h-4 opacity-60 group-hover:opacity-100" />
                  {t('drive.delete') || 'Delete'}
                </button>
              </>}
              {track && (
                <button onClick={handleDownloadClick}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1">
                  <Download className="w-4 h-4 opacity-60 group-hover:opacity-100" />
                  {t('menu.download')}
                </button>
              )}
            </>
          )}

          {track && (
            <div className="relative">
              <button onClick={(e) => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); setPlaylistSubmenuOpenLeft(rect.right + 270 > window.innerWidth); setShowPlaylistsSubmenu(!showPlaylistsSubmenu); }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center justify-between group mb-1">
                <div className="flex items-center gap-2">
                  <Music className="w-4 h-4 opacity-60 group-hover:opacity-100" />
                  {t('menu.add_to_playlist')}
                </div>
                <ChevronRight className="w-4 h-4 opacity-60 group-hover:opacity-100" />
              </button>
              {showPlaylistsSubmenu && (
                <PlaylistSubmenu playlists={playlists} track={track} openLeft={playlistSubmenuOpenLeft}
                  onClose={() => { setShowPlaylistsSubmenu(false); setIsOpen(false); onClose?.(); }} />
              )}
            </div>
          )}
        </div>,
        document.body
      )}

      <DownloadDialog isOpen={showDownloadDialog} fileName={downloadFileName}
        isDownloading={isDownloadingFile} onFileNameChange={setDownloadFileName}
        onDownload={() => { executeDownload(); setIsOpen(false); }}
        onClose={() => setShowDownloadDialog(false)} />

      <DeleteConfirmDialog isOpen={showDeleteConfirm} isDeleting={isDeleting}
        item={driveItem} onConfirm={handleDelete} onClose={() => setShowDeleteConfirm(false)} />

      {downloadMessage && createPortal(
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] animate-in slide-in-from-bottom-5 fade-in duration-300 w-full max-w-[90vw] md:max-w-md pointer-events-none">
          <div className="bg-white dark:bg-[#2a2b2f] text-gray-900 dark:text-white shadow-xl shadow-black/10 dark:shadow-black/30 rounded-full px-5 py-3 flex items-center gap-3">
            <div className="w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
              <span className="text-green-600 dark:text-green-400 text-sm">✓</span>
            </div>
            <p className="text-sm font-medium truncate" title={downloadMessage}>{downloadMessage}</p>
          </div>
        </div>,
        document.body
      )}

      {showMoveScreen && token && createPortal(
        <FolderSelectionScreen token={token} onSelectFolder={handleMove}
          onCancel={() => setShowMoveScreen(false)}
          initialFolderId={currentFolderId || 'root'} initialFolderName={currentFolderName}
          initialFolderHistory={folderHistory}
          title={t('drive.move_to') || 'Move to...'}
          subtitle={`${t('drive.move_item_desc') || 'Select destination for'} ${driveItem?.title}`} />,
        document.body
      )}
    </div>
  );
}
