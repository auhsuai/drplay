import type { TFunction } from "i18next";
import type { Track, DriveItem } from "../../../types";
import type { Playlist } from "../../../utils/playlists";
import type { useMenuPlaylists } from "../../../hooks/useMenuPlaylists";
import type { MoreMenuVariant } from "./constants";
import { AddToPlaylistItem } from "./AddToPlaylistItem";
import { DefaultMenuItems } from "./DefaultMenuItems";
import { PlayerBarMenuItems } from "./PlayerBarMenuItems";
import { PlaylistMenuItems } from "./PlaylistMenuItems";
import { QueueMenuItems } from "./QueueMenuItems";
import { RecentMenuItems } from "./RecentMenuItems";
import { SidebarPlaylistMenuItems } from "./SidebarPlaylistMenuItems";

/** Nguyên văn return của hook — 1 nguồn sự thật, không khai lại 10 field. */
type PlaylistsState = ReturnType<typeof useMenuPlaylists>;

interface MoreMenuSubject {
  track?: Track | undefined;
  driveItem?: DriveItem | undefined;
  token?: string | null | undefined;
  queueFolder?: { id: string; name: string } | undefined;
  playlist?: Playlist | undefined;
}

/** 4 callback do hook nội bộ của MoreMenu sinh ra. */
interface MoreMenuRowActions {
  handleDownloadClick: (
    e: React.MouseEvent,
    track: Track | undefined,
    setIsOpen: (o: boolean) => void,
  ) => void;
  handleNavigateClick: (e: React.MouseEvent) => void;
  handleAddToQueueClick: (
    e: React.MouseEvent,
    driveItem: DriveItem | undefined,
    track: Track | undefined,
    token: string | null | undefined,
    setIsOpen: (o: boolean) => void,
    onClose?: () => void,
  ) => void;
  openDeleteConfirm: (item: DriveItem) => void;
}

/** Callback do CALLER (MoreMenuProps) truyền vào — chỉ nhánh variant tương ứng dùng. */
interface MoreMenuVariantActions {
  onSelectMultiple?: (() => void) | undefined;
  onRemoveFromPlaylist?: (() => void) | undefined;
  onRemoveFromQueue?: (() => void) | undefined;
  onRemoveFolderFromQueue?: (() => void) | undefined;
  onRenamePlaylist?: (() => void) | undefined;
  onDeletePlaylist?: (() => void) | undefined;
  onTogglePinPlaylist?: (() => void) | undefined;
  onToggleQueue?: (() => void) | undefined;
  onBulkMoveClick?: (() => void) | undefined;
  onBulkDeleteClick?: (() => void) | undefined;
  setShowMoveScreen: (value: boolean) => void;
}

interface MoreMenuFlags {
  isAddingToQueue: boolean;
  disableRemoveFromQueue?: boolean | undefined;
  isBulkSelected?: boolean | undefined;
  isQueueOpen?: boolean | undefined;
}

interface MoreMenuCloseHandlers {
  setIsOpen: (open: boolean) => void;
  onClose?: (() => void) | undefined;
}

export interface MoreMenuContentProps {
  mode: MoreMenuVariant;
  subject: MoreMenuSubject;
  actions: MoreMenuRowActions;
  variantActions: MoreMenuVariantActions;
  flags: MoreMenuFlags;
  playlists: PlaylistsState;
  close: MoreMenuCloseHandlers;
  t: TFunction;
}

/**
 * Row router for the MoreMenu portal: the six child components render their
 * own rows from `subject` + callbacks, so this component only picks the branch
 * for `mode` and appends the shared Add-to-Playlist row. No wrapper element is
 * added — the fragment keeps the roles and DOM order the dropdown relies on.
 */
export function MoreMenuContent({
  mode,
  subject,
  actions,
  variantActions,
  flags,
  playlists,
  close,
  t,
}: MoreMenuContentProps) {
  const { track, driveItem, token, queueFolder, playlist } = subject;
  const {
    handleDownloadClick,
    handleNavigateClick,
    handleAddToQueueClick,
    openDeleteConfirm,
  } = actions;
  const {
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
  } = variantActions;
  const {
    isAddingToQueue,
    disableRemoveFromQueue,
    isBulkSelected,
    isQueueOpen,
  } = flags;
  const { setIsOpen, onClose } = close;

  return (
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
      ) : mode === "playlist" ? (
        <PlaylistMenuItems
          track={track}
          handleNavigateClick={handleNavigateClick}
          onSelectMultiple={onSelectMultiple}
          onRemoveFromPlaylist={onRemoveFromPlaylist}
          setIsOpen={setIsOpen}
          onClose={onClose}
          t={t}
        />
      ) : mode === "sidebarPlaylist" ? (
        <SidebarPlaylistMenuItems
          playlist={playlist}
          onRename={onRenamePlaylist}
          onDelete={onDeletePlaylist}
          onTogglePin={onTogglePinPlaylist}
          setIsOpen={setIsOpen}
          onClose={onClose}
          t={t}
        />
      ) : mode === "playerbar" ? (
        <PlayerBarMenuItems
          track={track}
          handleDownloadClick={handleDownloadClick}
          handleNavigateClick={handleNavigateClick}
          setIsOpen={setIsOpen}
          t={t}
          isQueueOpen={isQueueOpen}
          onToggleQueue={onToggleQueue}
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

      {/* Playlist rows already belong to a playlist — adding them elsewhere
          is not part of the playlist row menu. The sidebar playlist menu is
          not track-scoped at all. */}
      {mode !== "playlist" && mode !== "sidebarPlaylist" && (
        <AddToPlaylistItem
          track={track}
          showPlaylistsSubmenu={playlists.showPlaylistsSubmenu}
          playlistSearchQuery={playlists.playlistSearchQuery}
          setPlaylistSearchQuery={playlists.setPlaylistSearchQuery}
          playlistCurrentPage={playlists.playlistCurrentPage}
          setPlaylistCurrentPage={playlists.setPlaylistCurrentPage}
          playlistSubmenuOpenLeft={playlists.playlistSubmenuOpenLeft}
          playlists={playlists.playlists}
          handleAddToPlaylist={playlists.handleAddToPlaylist}
          handleToggleSubmenu={playlists.handleToggleSubmenu}
          setIsOpen={setIsOpen}
          onClose={onClose}
          t={t}
        />
      )}
    </>
  );
}
