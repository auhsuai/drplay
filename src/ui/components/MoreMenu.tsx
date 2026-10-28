import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Track } from "../../types";
import type { DriveItem } from "../../types";
import type { Playlist } from "../../utils/playlists";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { useTranslation } from "react-i18next";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

// Custom Hooks and Components
import { useMenuDownload } from "../../hooks/useMenuDownload";
import { useMenuDelete } from "../../hooks/useMenuDelete";
import { useMenuPlaylists } from "../../hooks/useMenuPlaylists";
import { useMenuAddToQueue } from "../../hooks/useMenuAddToQueue";
import { DeleteConfirmDialog } from "./MoreMenu/DeleteConfirmDialog";
import { DownloadDialog } from "./MoreMenu/DownloadDialog";
import { DownloadToast } from "./MoreMenu/DownloadToast";
import { MoreMenuContent } from "./MoreMenu/MoreMenuContent";
import { MoreMenuTrigger } from "./MoreMenu/MoreMenuTrigger";
import { useMenuMove } from "./MoreMenu/useMenuMove";
import { useMoreMenuEvents } from "./MoreMenu/useMoreMenuEvents";
import {
  getContextMenuStyle,
  shouldOpenUpwards,
} from "./MoreMenu/menuPositioning";
import { useMenuKeyboardNavigation } from "./MoreMenu/useMenuKeyboardNavigation";
import { EVENT_LOCATE_FILE } from "./MoreMenu/constants";
import type { MoreMenuVariant } from "./MoreMenu/constants";

export type { MoreMenuVariant } from "./MoreMenu/constants";

export interface MoreMenuProps {
  track?: Track | undefined;
  driveItem?: DriveItem;
  token?: string | null | undefined;
  currentFolderId?: string;
  currentFolderName?: string;
  folderHistory?: { id: string; name: string }[];
  onRefresh?: () => void;
  onRemoveItem?: ((id: string) => void) | undefined;
  forceOpen?: boolean;
  onClose?: () => void;
  anchorPoint?: { x: number; y: number } | null;
  onOpenChange?: (isOpen: boolean) => void;
  onSelectMultiple?: () => void;
  isPlayerBarMode?: boolean;
  variant?: MoreMenuVariant | undefined;
  isBulkSelected?: boolean | undefined;
  onBulkMoveClick?: (() => void) | undefined;
  onBulkDeleteClick?: (() => void) | undefined;
  onRemoveFromQueue?: (() => void) | undefined;
  disableRemoveFromQueue?: boolean | undefined;
  onRemoveFolderFromQueue?: (() => void) | undefined;
  queueFolder?: { id: string; name: string } | undefined;
  onRemoveFromPlaylist?: (() => void) | undefined;
  // Sidebar playlist menu (variant="sidebarPlaylist"): the playlist the menu
  // manages. The actions receive no inferred context — the caller binds them
  // to this exact object.
  playlist?: Playlist | undefined;
  onRenamePlaylist?: (() => void) | undefined;
  onDeletePlaylist?: (() => void) | undefined;
  onTogglePinPlaylist?: (() => void) | undefined;
  // PlayerBar variant only: the queue toggle lives inside this menu (checked
  // row). Other variants never receive these props.
  isQueueOpen?: boolean | undefined;
  onToggleQueue?: (() => void) | undefined;
}

export function MoreMenu({
  track,
  driveItem,
  token,
  currentFolderId,
  currentFolderName,
  folderHistory,
  onRefresh,
  onRemoveItem,
  forceOpen,
  onClose,
  anchorPoint,
  onOpenChange,
  onSelectMultiple,
  isPlayerBarMode,
  variant,
  isBulkSelected,
  onBulkMoveClick,
  onBulkDeleteClick,
  onRemoveFromQueue,
  disableRemoveFromQueue,
  onRemoveFolderFromQueue,
  queueFolder,
  onRemoveFromPlaylist,
  playlist,
  onRenamePlaylist,
  onDeletePlaylist,
  onTogglePinPlaylist,
  isQueueOpen,
  onToggleQueue,
}: MoreMenuProps) {
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
  const mode: MoreMenuVariant =
    variant ?? (isPlayerBarMode ? "playerbar" : "default");

  // -- Hooks --
  const {
    isDownloadingFile,
    showDownloadDialog,
    setShowDownloadDialog,
    downloadFileName,
    setDownloadFileName,
    downloadMessage,
    setDownloadMessage,
    handleDownloadClick,
    executeDownload,
  } = useMenuDownload(t);

  const {
    isDeleting,
    showDeleteConfirm,
    setShowDeleteConfirm,
    deleteDriveItem,
    handleDelete,
    openDeleteConfirm,
  } = useMenuDelete(t);

  const { isAddingToQueue, handleAddToQueueClick } = useMenuAddToQueue(t);

  const menuPlaylists = useMenuPlaylists(!!isMenuOpen, t);
  const { showPlaylistsSubmenu, setShowPlaylistsSubmenu } = menuPlaylists;

  const { showMoveScreen, setShowMoveScreen, handleMove } = useMenuMove({
    driveItem,
    token,
    currentFolderId,
    onRemoveItem,
    onRefresh,
    onClose,
    setIsOpen,
  });

  const { closeMenu } = useMoreMenuEvents({
    isMenuOpen,
    setIsOpen,
    onClose,
    menuRef,
    dropdownRef,
    setShowPlaylistsSubmenu,
    // APG focus return only for menus opened from the trigger; the
    // anchor/context-menu path (SongCard right-click) keeps its own focus.
    restoreFocus: !forceOpen && !anchorPoint,
  });

  const { setPendingFocus, handleMenuKeyDown } = useMenuKeyboardNavigation({
    isMenuOpen,
    dropdownRef,
    closeMenu,
    showPlaylistsSubmenu,
    setShowPlaylistsSubmenu,
  });

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Loading / MainContent"):
  // a fake download completion message, rendered through the exact
  // DownloadToast portal the real download flow uses. onDebugEvent no-ops
  // in production builds; the listener never runs there.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.DOWNLOAD_TOAST, (detail) => {
      setDownloadMessage(detail.message);
    });
  }, [setDownloadMessage]);

  const handleNavigateClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (track) {
      window.dispatchEvent(
        new CustomEvent(EVENT_LOCATE_FILE, {
          detail: {
            fileId: track.id,
            parentId: track.parentId,
            parentName: track.parentName,
          },
        }),
      );
    } else if (queueFolder) {
      // Queue is not a Drive browser: the locate flow fetches the parent
      // chain itself from fileId (useLocateFile), so a folder row only needs
      // its own id.
      window.dispatchEvent(
        new CustomEvent(EVENT_LOCATE_FILE, {
          detail: { fileId: queueFolder.id },
        }),
      );
    } else {
      return;
    }
    setIsOpen(false);
    onClose?.();
  };

  const renderMenuContent = () => (
    <MoreMenuContent
      mode={mode}
      subject={{ track, driveItem, token, queueFolder, playlist }}
      actions={{
        handleDownloadClick,
        handleNavigateClick,
        handleAddToQueueClick,
        openDeleteConfirm,
      }}
      variantActions={{
        onSelectMultiple,
        onRemoveFromPlaylist,
        onRemoveFromQueue,
        onRemoveFolderFromQueue,
        onRenamePlaylist,
        onDeletePlaylist,
        onTogglePinPlaylist,
        onToggleQueue,
        onBulkMoveClick,
        onBulkDeleteClick,
        setShowMoveScreen,
      }}
      flags={{
        isAddingToQueue,
        disableRemoveFromQueue,
        isBulkSelected,
        isQueueOpen,
      }}
      playlists={menuPlaylists}
      close={{ setIsOpen, onClose }}
      t={t}
    />
  );

  return (
    <div
      className="relative"
      ref={menuRef}
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <MoreMenuTrigger
        isOpen={isOpen}
        isMenuOpen={isMenuOpen}
        isDownloadingFile={isDownloadingFile}
        large={isPlayerBarMode}
        onToggle={() => {
          setIsOpen(!isOpen);
        }}
        onMeasure={(rect) => {
          setButtonRect(rect);
          setOpenUpwards(shouldOpenUpwards(rect));
        }}
        onArrowOpen={(position) => {
          setPendingFocus(position);
          setIsOpen(true);
        }}
      />

      {isMenuOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
            aria-label={t("common.more_actions")}
            tabIndex={-1}
            className={`fixed z-[9999] w-60 bg-white dark:bg-[#2a2b2f] rounded-xl shadow-lg p-1.5 flex flex-col transition-all animate-in fade-in zoom-in-95 duration-200 border border-transparent ring-0 outline-none ${anchorPoint ? "" : openUpwards ? "origin-bottom-right" : "origin-top-right"}`}
            style={getContextMenuStyle({
              anchorPoint,
              buttonRect,
              openUpwards,
            })}
            onClick={(e) => {
              e.stopPropagation();
            }}
            onKeyDown={handleMenuKeyDown}
            onContextMenu={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
          >
            {renderMenuContent()}
          </div>,
          document.body,
        )}

      {createPortal(
        <DownloadDialog
          show={showDownloadDialog}
          isDownloadingFile={isDownloadingFile}
          downloadFileName={downloadFileName}
          setDownloadFileName={setDownloadFileName}
          onClose={() => {
            setShowDownloadDialog(false);
          }}
          onConfirm={() => {
            void executeDownload();
          }}
          t={t}
        />,
        document.body,
      )}

      {/* Toast Notification */}
      {downloadMessage && <DownloadToast message={downloadMessage} />}

      {createPortal(
        <DeleteConfirmDialog
          show={showDeleteConfirm}
          isDeleting={isDeleting}
          driveItem={deleteDriveItem}
          onClose={() => {
            setShowDeleteConfirm(false);
          }}
          onConfirm={() => {
            void handleDelete(
              token,
              setIsOpen,
              onClose,
              onRemoveItem,
              onRefresh,
            );
          }}
          t={t}
        />,
        document.body,
      )}

      {/* Move Folder Selection Screen */}
      {showMoveScreen &&
        token &&
        createPortal(
          <FolderSelectionScreen
            token={token}
            onSelectFolder={(folderId) => {
              void handleMove(folderId);
            }}
            onCancel={() => {
              setShowMoveScreen(false);
              // APG focus return for the per-row path: the picker opened from
              // a menu item whose unmount left focus on body, so the
              // FolderSelectionScreen restore is a no-op here — put focus
              // back on this row's ⋯ trigger.
              menuRef.current
                ?.querySelector<HTMLButtonElement>(
                  'button[aria-haspopup="menu"]',
                )
                ?.focus();
            }}
            initialFolderId={currentFolderId || ROOT_FOLDER_ID}
            initialFolderName={currentFolderName}
            initialFolderHistory={folderHistory}
            title={t("drive.move_to")}
            subtitle={`${t("drive.move_item_desc")} ${driveItem?.title ?? ""}`}
          />,
          document.body,
        )}
    </div>
  );
}
