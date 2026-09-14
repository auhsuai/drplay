import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { TabKey, Track } from "../../types";
import { usePlayerStore } from "../../store/playerStore";
import {
  removeTracksByFolderFromQueue,
  removeTracksFromQueue,
} from "../../store/queueOps";
import { buildQueueView } from "./queueView";
import type { QueueViewItem } from "./queueView";
import { QueueControls } from "./QueueControls";
import { QueueList } from "./QueueList";
import { QueueSearchInput } from "./QueueSearchInput";
import { QueueSelectionToolbar } from "./QueueSelectionToolbar";
import { useQueueSelection } from "./useQueueSelection";
import type { QueueSelection } from "./useQueueSelection";
import { normalizeText } from "../../utils/normalizeText";

function filterQueue(queue: Track[], query: string): Track[] {
  const needle = normalizeText(query.trim());
  if (!needle) return queue;
  return queue.filter((track) =>
    normalizeText(
      `${track.title} ${track.artist} ${track.folderGroupName ?? ""}`,
    ).includes(needle),
  );
}

// WCAG 4.1.3: announcing on every keystroke is noise — settle before speaking.
const SEARCH_STATUS_DEBOUNCE_MS = 400;

export interface QueuePanelProps {
  open: boolean;
  onClose: () => void;
  onSelectTrack: (track: Track) => void;
  activeTab: TabKey;
}

/**
 * Play-queue drawer docked to the right edge of the tab-content row in
 * AppShell: the actual playback order (playbackQueue), with search, per-row
 * menu and multi-select bulk removal. Rendered
 * inline (no portal/overlay) — the app stays usable while the pane slides
 * over the right side of the list, matching the sidebar's 300ms rhythm.
 */
export function QueuePanel({
  open,
  onClose,
  onSelectTrack,
  activeTab,
}: QueuePanelProps) {
  const { t } = useTranslation();
  const { playbackQueue, currentTrack } = usePlayerStore(
    useShallow((s) => ({
      playbackQueue: s.playbackQueue,
      currentTrack: s.currentTrack,
    })),
  );
  const [query, setQuery] = useState("");
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);

  // The open folder must still have members in the queue (bulk removal can
  // empty it): a stale id degrades to the root view during render — no
  // setState round-trip, no render loop.
  const effectiveFolderId =
    openFolderId !== null &&
    playbackQueue.some((track) => track.folderGroupId === openFolderId)
      ? openFolderId
      : null;

  // Once the open folder has no members left the view degrades to root; clear
  // the stale id during render too, or re-adding the same folder later would
  // silently drill back in without a click (same adjust-during-render rule).
  if (openFolderId !== null && effectiveFolderId === null) {
    setOpenFolderId(null);
  }

  const filteredTracks = useMemo(
    () => filterQueue(playbackQueue, query),
    [playbackQueue, query],
  );

  const viewItems = useMemo(
    () => buildQueueView(filteredTracks, effectiveFolderId, currentTrack),
    [filteredTracks, effectiveFolderId, currentTrack],
  );

  // WCAG 4.1.3 search-results status: the sr-only live region lives in
  // QueuePanelDialog; an empty query announces nothing (the region stays
  // mounted so it exists before its content ever changes). Clearing is
  // adjusted during render (same pattern as the stale-folder reset below) —
  // the effect must not setState synchronously.
  const [searchStatusText, setSearchStatusText] = useState("");
  if (query.trim() === "" && searchStatusText !== "") {
    setSearchStatusText("");
  }
  useEffect(() => {
    if (!query.trim()) return;
    const timeout = setTimeout(() => {
      setSearchStatusText(
        filteredTracks.length > 0
          ? t("queue.search_results_count", { count: filteredTracks.length })
          : t("queue.no_results"),
      );
    }, SEARCH_STATUS_DEBOUNCE_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [query, filteredTracks.length, t]);

  // viewItems feeds the hook: select-all is scoped to what the panel renders
  // (WYSIWYG) — see useQueueSelection.
  const selection = useQueueSelection(playbackQueue, currentTrack, viewItems);

  // Reset transient UI on every reopen — adjusted during render (React
  // "adjusting state during render" pattern) so no setState runs inside an
  // effect. hasOpened flips once: after the first open the pane CONTENT stays
  // mounted so the slide-out transition can play (and scroll/selection survive
  // a close); before that first open only the empty shell renders — mounting
  // the virtualized list and its row menus for a drawer nobody has seen is
  // pure waste.
  const [lastOpen, setLastOpen] = useState(open);
  const [hasOpened, setHasOpened] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    if (open) {
      setHasOpened(true);
      setQuery("");
      setOpenFolderId(null);
      selection.exitSelection();
    }
  }

  // QST-2: leaving selection mode unmounts the bulk toolbar; without this,
  // focus falls to <body> and Tab restarts from the top of the document.
  // Hand focus back to the selection toggle (wrapper ref, QueueControls).
  // The tracker resets while the panel is closed so the reopen-time selection
  // reset above cannot steal focus from the player bar.
  const selectionControlsRef = useRef<HTMLDivElement>(null);
  const wasInSelectionMode = useRef(false);
  useEffect(() => {
    if (!open) {
      wasInSelectionMode.current = false;
      return;
    }
    if (!selection.selectionMode && wasInSelectionMode.current) {
      selectionControlsRef.current?.querySelector("button")?.focus();
    }
    wasInSelectionMode.current = selection.selectionMode;
  }, [open, selection.selectionMode]);

  const openFolderName =
    effectiveFolderId === null
      ? null
      : (playbackQueue.find(
          (track) => track.folderGroupId === effectiveFolderId,
        )?.folderGroupName ?? "");

  // The drawer top aligns with the sticky header of the ACTIVE view: the
  // header is measured at runtime, so a view without one (LikedSongs,
  // Settings) keeps top 0. HomeTab keeps its other views mounted but hidden
  // (display:none → offsetParent null) — only VISIBLE headers count.
  // ResizeObserver also fires its initial observation right after observe(),
  // which is how the first measurement lands (no synchronous setState in the
  // effect body). Tab content is lazy (Suspense), so on a first visit the
  // header mounts AFTER this effect ran; if the scope keeps its size no
  // ResizeObserver tick follows and topOffset would stay stuck at the
  // previous view's value — hence the MutationObserver below.
  const paneRef = useRef<HTMLElement | null>(null);
  const [topOffset, setTopOffset] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const scope = paneRef.current?.parentElement;
    if (!scope) return;

    const measure = () => {
      const headers = scope.querySelectorAll<HTMLElement>("[data-view-header]");
      for (const header of headers) {
        if (header.offsetParent !== null) {
          // A header that mounted after this effect ran was never observed
          // (the loop below only saw the then-existing nodes): observing it
          // here is idempotent, missing it would freeze its measured size.
          observer.observe(header);
          setTopOffset(header.offsetHeight);
          return;
        }
      }
      setTopOffset(0);
    };

    const observer = new ResizeObserver(measure);
    // Observe the scope itself too: with no header (or a still-hidden one the
    // observer cannot observe) the initial observation still fires and
    // resolves topOffset back to 0 — a stale height from the previous tab
    // must never leak into the new one.
    observer.observe(scope);
    for (const header of scope.querySelectorAll("[data-view-header]")) {
      observer.observe(header);
    }

    // Lazy tab content mounts its header after the effect ran; catch that
    // insert/removal directly. Filtering to nodes that are (or carry) a
    // [data-view-header] keeps ordinary re-renders inside the scope — the
    // panel itself lives here — from triggering needless measurements.
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
          if (!(node instanceof Element)) continue;
          if (
            node.matches("[data-view-header]") ||
            node.querySelector("[data-view-header]")
          ) {
            measure();
            return;
          }
        }
      }
    });
    mutationObserver.observe(scope, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, [open, activeTab]);

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

  return (
    // eslint-disable-next-line jsx-a11y/no-redundant-roles -- explicit role is part of the drawer's fixed contract; <aside> implies the same complementary role.
    <aside
      ref={paneRef}
      data-testid="queue-panel"
      role="complementary"
      aria-label={t("queue.title")}
      aria-hidden={!open}
      inert={!open}
      style={{ top: topOffset }}
      className={`absolute right-0 bottom-0 w-[400px] flex flex-col bg-white dark:bg-[#121212] border-l border-gray-200/50 dark:border-gray-800/50 transition-transform duration-300 ease-in-out ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {hasOpened ? (
        <QueuePanelDialog
          onClose={onClose}
          selection={selection}
          selectionControlsRef={selectionControlsRef}
          query={query}
          onQueryChange={setQuery}
          items={viewItems}
          currentTrack={currentTrack}
          openFolderName={openFolderName}
          searchStatusText={searchStatusText}
          emptyKey={
            playbackQueue.length === 0 ? "queue.empty" : "queue.no_results"
          }
          onSelectTrack={onSelectTrack}
          onRemoveFromQueue={(key) => {
            removeTracksFromQueue([key]);
          }}
          onRemoveFolderFromQueue={removeTracksByFolderFromQueue}
          onOpenFolder={setOpenFolderId}
          onCloseFolder={() => {
            setOpenFolderId(null);
          }}
        />
      ) : null}
    </aside>
  );
}

interface QueuePanelDialogProps {
  onClose: () => void;
  selection: QueueSelection;
  selectionControlsRef: RefObject<HTMLDivElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  items: QueueViewItem[];
  currentTrack: Track | null;
  openFolderName: string | null;
  searchStatusText: string;
  emptyKey: "queue.empty" | "queue.no_results";
  onSelectTrack: (track: Track) => void;
  onRemoveFromQueue: (key: string) => void;
  onRemoveFolderFromQueue: (folderId: string) => void;
  onOpenFolder: (folderId: string) => void;
  onCloseFolder: () => void;
}

/** Drawer content: header, search+select row, bulk toolbar, list. */
function QueuePanelDialog({
  onClose,
  selection,
  selectionControlsRef,
  query,
  onQueryChange,
  items,
  currentTrack,
  openFolderName,
  searchStatusText,
  emptyKey,
  onSelectTrack,
  onRemoveFromQueue,
  onRemoveFolderFromQueue,
  onOpenFolder,
  onCloseFolder,
}: QueuePanelDialogProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4 p-6">
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

      <div className="flex flex-row items-center gap-2">
        <QueueSearchInput value={query} onChange={onQueryChange} />
        {/* Wrapper ref target for QST-2: QueuePanel focuses the toggle inside
            when the bulk toolbar unmounts (single button in here). */}
        <div ref={selectionControlsRef}>
          <QueueControls
            selectionMode={selection.selectionMode}
            onToggleSelectionMode={selection.toggleSelectionMode}
          />
        </div>
      </div>

      {/* WCAG 4.1.3 status message (ARIA22): the search-result count, kept
          mounted and empty until a query settles. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="queue-search-status"
        className="sr-only"
      >
        {searchStatusText}
      </div>

      {selection.selectionMode && (
        <QueueSelectionToolbar
          selectedCount={selection.selected.size}
          allSelected={selection.allSelected}
          onToggleSelectAll={selection.toggleSelectAll}
          onRemove={selection.removeSelected}
          onExit={selection.exitSelection}
        />
      )}

      {openFolderName !== null && (
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onCloseFolder}
            aria-label={t("queue.back")}
            title={t("queue.back")}
            className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
          >
            <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          </button>
          <span className="text-sm font-semibold truncate">
            {openFolderName}
          </span>
        </div>
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
        onOpenFolder={onOpenFolder}
      />
    </div>
  );
}
