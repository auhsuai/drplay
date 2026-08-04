import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Download, FolderOutput, Trash2, LoaderCircle, CheckCircle2, Music, ChevronRight, CheckSquare, MapPin } from "lucide-react";
import { Track } from "../../App";
import type { DriveItem } from "../../types";
import { moveFile } from "../../utils/driveApi";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { isUploading, subscribe as subscribeUploads } from "../../utils/uploadManager";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { useTranslation } from "react-i18next";
import { db } from "../../db/db";
import { captureError } from "../../utils/errorLog";
import { showErrorToast } from "../../utils/simpleToast";

// Custom Hooks and Components
import { useMenuDownload } from "../../hooks/useMenuDownload";
import { useMenuDelete } from "../../hooks/useMenuDelete";
import { useMenuPlaylists } from "../../hooks/useMenuPlaylists";
import { DownloadDialog } from "./MoreMenu/DownloadDialog";
import { DeleteConfirmDialog } from "./MoreMenu/DeleteConfirmDialog";
import { PlaylistsSubmenu } from "./MoreMenu/PlaylistsSubmenu";

const MORE_MENU_MODULE = 'MoreMenu';
const EVENT_LOCATE_FILE = 'locate-file';

// Monotonic upload-status version: bumped on every uploadManager notify so the
// menu re-renders and re-derives isUploading() for the currently targeted item.
// Module-level (same pattern as MainContent's VirtualizedSongList) so a menu
// remounted mid-upload still starts from the latest version —
// useSyncExternalStore re-reads the snapshot right after subscribing.
let uploadStatusVersion = 0;

const MENU_ITEM_BASE_CLASS = "w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center gap-2 group mb-1";
const MENU_ITEM_DELETE_CLASS = "w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all flex items-center gap-2 group mb-1";
// Applied when the targeted item is still uploading: actions must stay
// visible (the user sees why they are blocked) but must not be clickable.
const MENU_ITEM_UPLOADING_BLOCKED_CLASS = ' disabled:opacity-40 disabled:cursor-not-allowed';
const MENU_ESTIMATED_HEIGHT_PX = 250;   // estimated dropdown height used to decide open-up vs open-down

export type MoreMenuVariant = 'default' | 'playerbar' | 'recent';

export interface MoreMenuProps {
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
  variant?: MoreMenuVariant;
  isBulkSelected?: boolean;
  onBulkMoveClick?: () => void;
  onBulkDeleteClick?: () => void;
}

export function MoreMenu({ track, driveItem, token, currentFolderId, currentFolderName, folderHistory, onRefresh, onRemoveItem, forceOpen, onClose, anchorPoint, onOpenChange, onSelectMultiple, isPlayerBarMode, variant, isBulkSelected, onBulkMoveClick, onBulkDeleteClick }: MoreMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const [openUpwards, setOpenUpwards] = useState(true);

  const isMenuOpen = isOpen || forceOpen;
  // Why: 'recent' is a third curated mode for the Recent Files view (Delete +
  // Download Song + Add to Playlist + Navigate). isPlayerBarMode stays as the
  // legacy switch so PlayerBar does not need to change its call site.
  const mode: MoreMenuVariant = variant ?? (isPlayerBarMode ? 'playerbar' : 'default');

  // Re-render whenever an upload starts/finishes so the destructive actions
  // pick up the freshest isUploading() verdict while the menu is open (a menu
  // opened before the upload would otherwise keep stale enabled buttons).
  React.useSyncExternalStore(
    (onStoreChange) => subscribeUploads(() => {
      uploadStatusVersion += 1;
      onStoreChange();
    }),
    () => uploadStatusVersion,
  );

  const guardedId = driveItem?.id ?? track?.id;
  const isTargetUploading = guardedId !== undefined && isUploading(guardedId);
  const uploadBlockedTitle = isTargetUploading ? t('upload.uploading_blocked') : undefined;
  const uploadingBlocked = (extraClass: string): string =>
    isTargetUploading ? `${extraClass}${MENU_ITEM_UPLOADING_BLOCKED_CLASS}` : extraClass;

  // -- Hooks --
  const { 
    isDownloadingFile, showDownloadDialog, setShowDownloadDialog,
    downloadFileName, setDownloadFileName, downloadMessage,
    handleDownloadClick, executeDownload 
  } = useMenuDownload(t);

  const {
    isDeleting, showDeleteConfirm, setShowDeleteConfirm,
    deleteDriveItem, handleDelete, openDeleteConfirm
  } = useMenuDelete(t);

  const {
    showPlaylistsSubmenu, playlistSearchQuery, setPlaylistSearchQuery,
    playlistCurrentPage, setPlaylistCurrentPage, playlistSubmenuOpenLeft,
    playlists, handleAddToPlaylist, handleToggleSubmenu, setShowPlaylistsSubmenu
  } = useMenuPlaylists(!!isMenuOpen, t);

  // -- Move logic --
  const [showMoveScreen, setShowMoveScreen] = useState(false);
  const handleMove = async (newParentId: string) => {
    if (!driveItem || !token || !currentFolderId) return;
    if (newParentId === currentFolderId) {
      setShowMoveScreen(false); setIsOpen(false); onClose?.();
      return;
    }

    const itemId = driveItem.id;
    const oldParentId = currentFolderId;

    setShowMoveScreen(false); setIsOpen(false); onClose?.();

    try {
      await moveFile(token, itemId, oldParentId, newParentId);
      await db.files.update(itemId, { parentId: newParentId });
      if (onRemoveItem) onRemoveItem(itemId);
    } catch (e) {
      captureError({ level: 'error', source: MORE_MENU_MODULE, message: `move-failed: ${e instanceof Error ? e.message : String(e)}` });
      showErrorToast(t('drive.move_error', 'Failed to move item'));
      if (onRefresh) onRefresh();
    }
  };

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  const getContextMenuStyle = (): React.CSSProperties | undefined => {
    if (anchorPoint) {
      const style: React.CSSProperties = {};
      if (anchorPoint.x > window.innerWidth / 2) style.right = window.innerWidth - anchorPoint.x;
      else style.left = anchorPoint.x;
      
      if (anchorPoint.y > window.innerHeight / 2) style.bottom = window.innerHeight - anchorPoint.y;
      else style.top = anchorPoint.y;
      return style;
    }

    if (buttonRect) {
      const style: React.CSSProperties = {};
      style.right = window.innerWidth - buttonRect.right;
      if (openUpwards) style.bottom = window.innerHeight - buttonRect.top + 8;
      else style.top = buttonRect.bottom + 8;
      return style;
    }
    return undefined;
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(event.target as Node) &&
        (!dropdownRef.current || !dropdownRef.current.contains(event.target as Node))
      ) {
        setIsOpen(false);
        setShowPlaylistsSubmenu(false);
        onClose?.();
      }
    };

    const handleScroll = (e: Event) => {
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setIsOpen(false);
      setShowPlaylistsSubmenu(false);
      onClose?.();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setShowPlaylistsSubmenu(false);
        onClose?.();
      }
    };

    if (isMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      window.addEventListener("scroll", handleScroll, true);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen, onClose, setShowPlaylistsSubmenu]);

  const handleNavigateClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!track) return;
    window.dispatchEvent(new CustomEvent(EVENT_LOCATE_FILE, {
      detail: {
        fileId: track.id,
        parentId: track.parentId,
        parentName: track.parentName
      }
    }));
    setIsOpen(false);
    onClose?.();
  };

  const renderMenuContent = () => (
    <>
      {mode === 'playerbar' ? (
        <>
          {track && (
            <>
              <button
                onClick={(e) => handleDownloadClick(e, track, setIsOpen)}
                className={uploadingBlocked(`${MENU_ITEM_BASE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`)}
                disabled={isTargetUploading}
                title={uploadBlockedTitle}
              >
                <Download className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('menu.download_song', 'Download Song')}</span>
              </button>

              <button
                onClick={handleNavigateClick}
                className={MENU_ITEM_BASE_CLASS}
              >
                <MapPin className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('menu.navigate', 'Locate File')}</span>
              </button>
            </>
          )}
        </>
      ) : mode === 'recent' ? (
        <>
          {driveItem && token && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openDeleteConfirm(driveItem); setIsOpen(false); onClose?.();
              }}
              className={uploadingBlocked(MENU_ITEM_DELETE_CLASS)}
              disabled={isTargetUploading}
              title={uploadBlockedTitle}
            >
              <Trash2 className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
              <span className="truncate">{t('drive.delete') || 'Delete'}</span>
            </button>
          )}

          {track && (
            <>
              <button
                onClick={(e) => handleDownloadClick(e, track, setIsOpen)}
                className={uploadingBlocked(`${MENU_ITEM_BASE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`)}
                disabled={isTargetUploading}
                title={uploadBlockedTitle}
              >
                <Download className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('menu.download_song', 'Download Song')}</span>
              </button>

              <button
                onClick={handleNavigateClick}
                className={MENU_ITEM_BASE_CLASS}
              >
                <MapPin className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('menu.navigate', 'Locate File')}</span>
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
                  e.stopPropagation(); setIsOpen(false); onClose?.(); onSelectMultiple?.();
                }}
                className={uploadingBlocked(MENU_ITEM_BASE_CLASS)}
                disabled={isTargetUploading}
                title={uploadBlockedTitle}
              >
                <CheckSquare className="w-4 h-4 text-gray-400 group-hover:text-[#4285F4]" />
                {t('menu.select_multiple', 'Đa chọn')}
              </button>
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  if (isBulkSelected && onBulkMoveClick) {
                    setIsOpen(false); onClose?.(); onBulkMoveClick();
                  } else {
                    setShowMoveScreen(true); setIsOpen(false); onClose?.(); 
                  }
                }}
                className={uploadingBlocked(MENU_ITEM_BASE_CLASS)}
                disabled={isTargetUploading}
                title={uploadBlockedTitle}
              >
                <FolderOutput className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('drive.move_to') || 'Move to...'}</span>
              </button>
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  if (isBulkSelected && onBulkDeleteClick) {
                    setIsOpen(false); onClose?.(); onBulkDeleteClick();
                  } else {
                    openDeleteConfirm(driveItem); setIsOpen(false); onClose?.(); 
                  }
                }}
                className={uploadingBlocked(MENU_ITEM_DELETE_CLASS)}
                disabled={isTargetUploading}
                title={uploadBlockedTitle}
              >
                <Trash2 className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
                <span className="truncate">{t('drive.delete') || 'Delete'}</span>
              </button>
            </>
          )}

          {track && (
            <button
              onClick={(e) => handleDownloadClick(e, track, setIsOpen)}
              className={uploadingBlocked(`${MENU_ITEM_BASE_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`)}
              disabled={isTargetUploading}
              title={uploadBlockedTitle}
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
            onClick={handleToggleSubmenu}
            className={uploadingBlocked("w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-[#33343a] hover:text-[#4285F4] rounded-md transition-all flex items-center justify-between group mb-1")}
            disabled={isTargetUploading}
            title={uploadBlockedTitle}
          >
            <div className="flex items-center gap-2">
              <Music className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
              <span className="truncate">{t('menu.add_to_playlist')}</span>
            </div>
            <ChevronRight className="w-4 h-4 opacity-60 group-hover:opacity-100 transition-opacity" />
          </button>

          <PlaylistsSubmenu
            showPlaylistsSubmenu={showPlaylistsSubmenu}
            playlistSearchQuery={playlistSearchQuery}
            setPlaylistSearchQuery={setPlaylistSearchQuery}
            playlistCurrentPage={playlistCurrentPage}
            setPlaylistCurrentPage={setPlaylistCurrentPage}
            playlistSubmenuOpenLeft={playlistSubmenuOpenLeft}
            playlists={playlists}
            onAddToPlaylist={(e, pId) => handleAddToPlaylist(e, pId, track, setIsOpen, onClose)}
            t={t}
          />
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
              setOpenUpwards(rect.bottom + MENU_ESTIMATED_HEIGHT_PX > window.innerHeight);
            }
            setIsOpen(!isOpen); 
          } 
        }}
        disabled={isDownloadingFile}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        className={`relative p-2 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-[#4285F4]/40 ${isDownloadingFile ? 'cursor-default opacity-50' : 'text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#33343a]'}`}
      >
        {isDownloadingFile ? (
          <LoaderCircle className="w-5 h-5 animate-spin text-[#4285F4]" />
        ) : (
          <MoreHorizontal className="w-5 h-5" />
        )}
      </button>

      {isMenuOpen && createPortal(
        <div 
          ref={dropdownRef}
          role="menu"
          className={`fixed z-[9999] w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 flex flex-col transition-all animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none ${anchorPoint ? '' : (openUpwards ? 'origin-bottom-right' : 'origin-top-right')}`}
          style={getContextMenuStyle()}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => { e.stopPropagation(); e.preventDefault(); }}
        >
          {renderMenuContent()}
        </div>,
        document.body
      )}

      {createPortal(
        <DownloadDialog
          show={showDownloadDialog}
          isDownloadingFile={isDownloadingFile}
          downloadFileName={downloadFileName}
          setDownloadFileName={setDownloadFileName}
          onClose={() => setShowDownloadDialog(false)}
          onConfirm={executeDownload}
          t={t}
        />,
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

      {createPortal(
        <DeleteConfirmDialog
          show={showDeleteConfirm}
          isDeleting={isDeleting}
          driveItem={deleteDriveItem}
          onClose={() => setShowDeleteConfirm(false)}
          onConfirm={() => handleDelete(token, setIsOpen, onClose, onRemoveItem, onRefresh)}
          t={t}
        />,
        document.body
      )}

      {/* Move Folder Selection Screen */}
      {showMoveScreen && token && createPortal(
        <FolderSelectionScreen
          token={token}
          onSelectFolder={handleMove}
          onCancel={() => setShowMoveScreen(false)}
          initialFolderId={currentFolderId || ROOT_FOLDER_ID}
          initialFolderName={currentFolderName}
          initialFolderHistory={folderHistory}
          title={t('drive.move_to', 'Move to...')}
          subtitle={`${t('drive.move_item_desc', 'Select destination for')} ${driveItem?.title}`}
        />,
        document.body
      )}
    </div>
  );
}
