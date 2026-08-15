import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Track } from "../../types";
import type { DriveItem } from "../../types";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import {
  isUploading,
  subscribe as subscribeUploads,
} from "../../utils/uploadManager";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { useTranslation } from "react-i18next";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

// Custom Hooks and Components
import { useMenuDownload } from "../../hooks/useMenuDownload";
import { useMenuDelete } from "../../hooks/useMenuDelete";
import { useMenuPlaylists } from "../../hooks/useMenuPlaylists";
import { AddToPlaylistItem } from "./MoreMenu/AddToPlaylistItem";
import { DefaultMenuItems } from "./MoreMenu/DefaultMenuItems";
import { DeleteConfirmDialog } from "./MoreMenu/DeleteConfirmDialog";
import { DownloadDialog } from "./MoreMenu/DownloadDialog";
import { DownloadToast } from "./MoreMenu/DownloadToast";
import { MoreMenuTrigger } from "./MoreMenu/MoreMenuTrigger";
import { PlayerBarMenuItems } from "./MoreMenu/PlayerBarMenuItems";
import { RecentMenuItems } from "./MoreMenu/RecentMenuItems";
import { useMenuMove } from "./MoreMenu/useMenuMove";
import { useMoreMenuEvents } from "./MoreMenu/useMoreMenuEvents";
import {
  getContextMenuStyle,
  shouldOpenUpwards,
} from "./MoreMenu/menuPositioning";
import {
  EVENT_LOCATE_FILE,
  MENU_ITEM_UPLOADING_BLOCKED_CLASS,
  bumpUploadStatusVersion,
  getUploadStatusVersion,
} from "./MoreMenu/constants";
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
  /** Compact mobile sizing (Task 13): smaller trigger button (h-8 w-8, 16px icon). */
  compact?: boolean;
  variant?: MoreMenuVariant | undefined;
  isBulkSelected?: boolean | undefined;
  onBulkMoveClick?: (() => void) | undefined;
  onBulkDeleteClick?: (() => void) | undefined;
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
  compact,
  variant,
  isBulkSelected,
  onBulkMoveClick,
  onBulkDeleteClick,
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

  // Re-render whenever an upload starts/finishes so the destructive actions
  // pick up the freshest isUploading() verdict while the menu is open (a menu
  // opened before the upload would otherwise keep stale enabled buttons).
  React.useSyncExternalStore(
    (onStoreChange) =>
      subscribeUploads(() => {
        bumpUploadStatusVersion();
        onStoreChange();
      }),
    () => getUploadStatusVersion(),
  );

  const guardedId = driveItem?.id ?? track?.id;
  const isTargetUploading = guardedId !== undefined && isUploading(guardedId);
  const uploadBlockedTitle = isTargetUploading
    ? t("upload.uploading_blocked")
    : undefined;
  const uploadingBlocked = (extraClass: string): string =>
    isTargetUploading
      ? `${extraClass}${MENU_ITEM_UPLOADING_BLOCKED_CLASS}`
      : extraClass;

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

  const {
    showPlaylistsSubmenu,
    playlistSearchQuery,
    setPlaylistSearchQuery,
    playlistCurrentPage,
    setPlaylistCurrentPage,
    playlistSubmenuOpenLeft,
    playlists,
    handleAddToPlaylist,
    handleToggleSubmenu,
    setShowPlaylistsSubmenu,
  } = useMenuPlaylists(!!isMenuOpen, t);

  const { showMoveScreen, setShowMoveScreen, handleMove } = useMenuMove({
    driveItem,
    token,
    currentFolderId,
    onRemoveItem,
    onRefresh,
    onClose,
    setIsOpen,
  });

  useMoreMenuEvents({
    isMenuOpen,
    setIsOpen,
    onClose,
    menuRef,
    dropdownRef,
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
    if (!track) return;
    window.dispatchEvent(
      new CustomEvent(EVENT_LOCATE_FILE, {
        detail: {
          fileId: track.id,
          parentId: track.parentId,
          parentName: track.parentName,
        },
      }),
    );
    setIsOpen(false);
    onClose?.();
  };

  const renderMenuContent = () => (
    <>
      {mode === "playerbar" ? (
        <PlayerBarMenuItems
          track={track}
          handleDownloadClick={handleDownloadClick}
          handleNavigateClick={handleNavigateClick}
          uploadingBlocked={uploadingBlocked}
          isTargetUploading={isTargetUploading}
          uploadBlockedTitle={uploadBlockedTitle}
          setIsOpen={setIsOpen}
          t={t}
        />
      ) : mode === "recent" ? (
        <RecentMenuItems
          track={track}
          driveItem={driveItem}
          token={token}
          handleDownloadClick={handleDownloadClick}
          handleNavigateClick={handleNavigateClick}
          openDeleteConfirm={openDeleteConfirm}
          uploadingBlocked={uploadingBlocked}
          isTargetUploading={isTargetUploading}
          uploadBlockedTitle={uploadBlockedTitle}
          setIsOpen={setIsOpen}
          onClose={onClose}
          t={t}
        />
      ) : (
        <DefaultMenuItems
          track={track}
          driveItem={driveItem}
          token={token}
          handleDownloadClick={handleDownloadClick}
          openDeleteConfirm={openDeleteConfirm}
          uploadingBlocked={uploadingBlocked}
          isTargetUploading={isTargetUploading}
          uploadBlockedTitle={uploadBlockedTitle}
          setIsOpen={setIsOpen}
          onClose={onClose}
          onSelectMultiple={onSelectMultiple}
          isBulkSelected={isBulkSelected}
          onBulkMoveClick={onBulkMoveClick}
          onBulkDeleteClick={onBulkDeleteClick}
          setShowMoveScreen={setShowMoveScreen}
          t={t}
        />
      )}

      <AddToPlaylistItem
        track={track}
        showPlaylistsSubmenu={showPlaylistsSubmenu}
        playlistSearchQuery={playlistSearchQuery}
        setPlaylistSearchQuery={setPlaylistSearchQuery}
        playlistCurrentPage={playlistCurrentPage}
        setPlaylistCurrentPage={setPlaylistCurrentPage}
        playlistSubmenuOpenLeft={playlistSubmenuOpenLeft}
        playlists={playlists}
        handleAddToPlaylist={handleAddToPlaylist}
        handleToggleSubmenu={handleToggleSubmenu}
        uploadingBlocked={uploadingBlocked}
        isTargetUploading={isTargetUploading}
        uploadBlockedTitle={uploadBlockedTitle}
        setIsOpen={setIsOpen}
        onClose={onClose}
        t={t}
      />
    </>
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
        compact={compact}
        onToggle={() => {
          setIsOpen(!isOpen);
        }}
        onMeasure={(rect) => {
          setButtonRect(rect);
          setOpenUpwards(shouldOpenUpwards(rect));
        }}
      />

      {isMenuOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
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
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setIsOpen(false);
                setShowPlaylistsSubmenu(false);
                onClose?.();
              }
            }}
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
