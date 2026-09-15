import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Track } from "../../types";
import type { DriveItem } from "../../types";
import { ROOT_FOLDER_ID } from "../../utils/driveConstants";
import { FolderSelectionScreen } from "../FolderSelection/FolderSelectionScreen";
import { useTranslation } from "react-i18next";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

// Custom Hooks and Components
import { useMenuDownload } from "../../hooks/useMenuDownload";
import { useMenuDelete } from "../../hooks/useMenuDelete";
import { useMenuPlaylists } from "../../hooks/useMenuPlaylists";
import { useMenuAddToQueue } from "../../hooks/useMenuAddToQueue";
import { AddToPlaylistItem } from "./MoreMenu/AddToPlaylistItem";
import { DefaultMenuItems } from "./MoreMenu/DefaultMenuItems";
import { DeleteConfirmDialog } from "./MoreMenu/DeleteConfirmDialog";
import { DownloadDialog } from "./MoreMenu/DownloadDialog";
import { DownloadToast } from "./MoreMenu/DownloadToast";
import { MoreMenuTrigger } from "./MoreMenu/MoreMenuTrigger";
import { PlayerBarMenuItems } from "./MoreMenu/PlayerBarMenuItems";
import { QueueMenuItems } from "./MoreMenu/QueueMenuItems";
import { RecentMenuItems } from "./MoreMenu/RecentMenuItems";
import { useMenuMove } from "./MoreMenu/useMenuMove";
import { useMoreMenuEvents } from "./MoreMenu/useMoreMenuEvents";
import {
  getContextMenuStyle,
  shouldOpenUpwards,
} from "./MoreMenu/menuPositioning";
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
}: MoreMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const [openUpwards, setOpenUpwards] = useState(true);

  const isMenuOpen = isOpen || forceOpen;
  const pendingFocusRef = useRef<"first" | "last">("first");
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

  // Keyboard support for the portal menu (APG menu button): the items are
  // rendered by several child components, so the roving set is queried from
  // the dropdown at event time (same approach as the dialog focus
  // containment in ImageCropperModal) instead of threading a prop through
  // every item caller. Only role="menuitem" entries participate, so the
  // playlists search input keeps its own arrow-key behavior.
  const getEnabledMenuItems = useCallback((): HTMLElement[] => {
    const root = dropdownRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).filter((item) => !item.hasAttribute("disabled"));
  }, []);

  const focusMenuItemAt = useCallback((index: number): void => {
    const root = dropdownRef.current;
    if (!root) return;
    const items = Array.from(
      root.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    const enabled = items.filter((item) => !item.hasAttribute("disabled"));
    if (enabled.length === 0) return;
    const target = enabled[(index + enabled.length) % enabled.length];
    // Keep exactly one tabIndex=0 in the menu: disabled entries are pulled
    // out of the roving set even though they keep their DOM position.
    items.forEach((item) => {
      item.tabIndex = item === target ? 0 : -1;
    });
    target?.focus();
  }, []);

  // APG: focus moves to the first item whenever the menu opens — trigger
  // click, optional trigger ArrowDown/Up, or the SongCard context menu.
  useEffect(() => {
    if (!isMenuOpen) return;
    const position = pendingFocusRef.current;
    pendingFocusRef.current = "first";
    focusMenuItemAt(position === "last" ? -1 : 0);
  }, [isMenuOpen, focusMenuItemAt]);

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
    <>
      {mode === "queue" ? (
        <QueueMenuItems
          track={track}
          queueFolder={queueFolder}
          handleDownloadClick={handleDownloadClick}
          handleNavigateClick={handleNavigateClick}
          onRemoveFromQueue={onRemoveFromQueue}
          disableRemoveFromQueue={disableRemoveFromQueue}
          onRemoveFolderFromQueue={onRemoveFolderFromQueue}
          setIsOpen={setIsOpen}
          t={t}
        />
      ) : mode === "playerbar" ? (
        <PlayerBarMenuItems
          track={track}
          handleDownloadClick={handleDownloadClick}
          handleNavigateClick={handleNavigateClick}
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
          handleAddToQueueClick={handleAddToQueueClick}
          isAddingToQueue={isAddingToQueue}
          openDeleteConfirm={openDeleteConfirm}
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
        onToggle={() => {
          setIsOpen(!isOpen);
        }}
        onMeasure={(rect) => {
          setButtonRect(rect);
          setOpenUpwards(shouldOpenUpwards(rect));
        }}
        onArrowOpen={(position) => {
          pendingFocusRef.current = position;
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
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (showPlaylistsSubmenu) {
                  // APG submenu-first order (P2-08-6): the first Escape closes
                  // only the submenu and returns focus to its parent menuitem;
                  // the next Escape closes the menu (closeMenu restores the
                  // trigger focus per P2-08-3).
                  setShowPlaylistsSubmenu(false);
                  dropdownRef.current
                    ?.querySelector<HTMLElement>(
                      '[role="menuitem"][aria-haspopup="menu"]',
                    )
                    ?.focus();
                  return;
                }
                closeMenu();
                return;
              }
              if (
                e.key !== "ArrowDown" &&
                e.key !== "ArrowUp" &&
                e.key !== "Home" &&
                e.key !== "End"
              ) {
                return;
              }
              // Arrow keys belong to the text cursor while typing in the
              // playlists search box — never to roving focus.
              if ((e.target as HTMLElement).closest("input, textarea")) return;
              e.preventDefault();
              const items = getEnabledMenuItems();
              if (items.length === 0) return;
              const current = items.indexOf(e.target as HTMLElement);
              if (e.key === "ArrowDown") {
                focusMenuItemAt(current < 0 ? 0 : current + 1);
              } else if (e.key === "ArrowUp") {
                focusMenuItemAt(current < 0 ? items.length - 1 : current - 1);
              } else if (e.key === "Home") {
                focusMenuItemAt(0);
              } else {
                focusMenuItemAt(items.length - 1);
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
