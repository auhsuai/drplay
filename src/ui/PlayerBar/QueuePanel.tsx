import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { PlayMode, Track } from "../../types";
import { usePlayerStore } from "../../store/playerStore";
import {
  removeTracksByFolderFromQueue,
  removeTracksFromQueue,
} from "../../store/queueOps";
import { QueueControls } from "./QueueControls";
import { QueueList } from "./QueueList";
import { QueueSearchInput } from "./QueueSearchInput";
import { QueueSelectionToolbar } from "./QueueSelectionToolbar";
import { useQueueSelection } from "./useQueueSelection";
import type { QueueSelection } from "./useQueueSelection";

// Vietnamese users type unaccented ("co" for "Có"): strip diacritics via NFD
// and lowercase both sides of the comparison.
function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function filterQueue(queue: Track[], query: string): Track[] {
  const needle = normalizeForSearch(query.trim());
  if (!needle) return queue;
  return queue.filter((track) =>
    normalizeForSearch(`${track.title} ${track.artist}`).includes(needle),
  );
}

export interface QueuePanelProps {
  open: boolean;
  onClose: () => void;
  onSetPlayMode: (mode: PlayMode) => void;
  onSelectTrack: (track: Track) => void;
}

/**
 * Play-queue modal: the actual playback order (playbackQueue), with search,
 * per-row menu, multi-select bulk removal and a direct play-mode switch.
 * Rendered through a portal because the PlayerBar ancestor creates a z-10 /
 * overflow context the fixed overlay must escape.
 */
export function QueuePanel({
  open,
  onClose,
  onSetPlayMode,
  onSelectTrack,
}: QueuePanelProps) {
  const { playbackQueue, currentTrack, playMode } = usePlayerStore(
    useShallow((s) => ({
      playbackQueue: s.playbackQueue,
      currentTrack: s.currentTrack,
      playMode: s.playMode,
    })),
  );
  const [query, setQuery] = useState("");
  const selection = useQueueSelection(playbackQueue, currentTrack);

  // Reset transient UI on every reopen — adjusted during render (React
  // "adjusting state during render" pattern) so no setState runs inside an
  // effect.
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    if (open) {
      setQuery("");
      selection.exitSelection();
    }
  }

  const items = useMemo(
    () => filterQueue(playbackQueue, query),
    [playbackQueue, query],
  );

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      data-testid="queue-overlay"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      role="presentation"
      onClick={(e) => {
        // Only the backdrop itself closes the panel, never a dialog click.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <QueuePanelDialog
        onClose={onClose}
        playMode={playMode}
        onSetPlayMode={onSetPlayMode}
        selection={selection}
        query={query}
        onQueryChange={setQuery}
        items={items}
        currentTrack={currentTrack}
        emptyKey={
          playbackQueue.length === 0 ? "queue.empty" : "queue.no_results"
        }
        onSelectTrack={onSelectTrack}
        onRemoveFromQueue={(key) => {
          removeTracksFromQueue([key]);
        }}
        onRemoveFolderFromQueue={removeTracksByFolderFromQueue}
      />
    </div>,
    document.body,
  );
}

interface QueuePanelDialogProps {
  onClose: () => void;
  playMode: PlayMode;
  onSetPlayMode: (mode: PlayMode) => void;
  selection: QueueSelection;
  query: string;
  onQueryChange: (value: string) => void;
  items: Track[];
  currentTrack: Track | null;
  emptyKey: "queue.empty" | "queue.no_results";
  onSelectTrack: (track: Track) => void;
  onRemoveFromQueue: (key: string) => void;
  onRemoveFolderFromQueue: (parentId: string) => void;
}

/** Dialog chrome: header, controls, search, bulk toolbar, list, footer. */
function QueuePanelDialog({
  onClose,
  playMode,
  onSetPlayMode,
  selection,
  query,
  onQueryChange,
  items,
  currentTrack,
  emptyKey,
  onSelectTrack,
  onRemoveFromQueue,
  onRemoveFolderFromQueue,
}: QueuePanelDialogProps) {
  const { t } = useTranslation();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("queue.title")}
      data-testid="queue-panel"
      className="bg-white dark:bg-[#202124] rounded-2xl p-6 w-full max-w-lg shadow-2xl flex flex-col gap-4 max-h-[75vh]"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-gray-900 dark:text-white">
          {t("queue.title")}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("settings.close")}
          className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-1 rounded-full transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <QueueControls
        playMode={playMode}
        onSetPlayMode={onSetPlayMode}
        selectionMode={selection.selectionMode}
        onToggleSelectionMode={selection.toggleSelectionMode}
      />

      <QueueSearchInput value={query} onChange={onQueryChange} />

      {selection.selectionMode && (
        <QueueSelectionToolbar
          selectedCount={selection.selected.size}
          allSelected={selection.allSelected}
          onToggleSelectAll={selection.toggleSelectAll}
          onRemove={selection.removeSelected}
          onExit={selection.exitSelection}
        />
      )}

      <QueueList
        items={items}
        currentTrack={currentTrack}
        selectionMode={selection.selectionMode}
        selected={selection.selected}
        emptyText={t(emptyKey)}
        onSelectTrack={onSelectTrack}
        onToggleSelected={selection.toggleSelected}
        onRemoveFromQueue={onRemoveFromQueue}
        onRemoveFolderFromQueue={onRemoveFolderFromQueue}
      />

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] rounded-xl transition-colors"
        >
          {t("settings.close")}
        </button>
      </div>
    </div>
  );
}
