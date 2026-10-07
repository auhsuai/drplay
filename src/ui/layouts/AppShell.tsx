import type { ReactNode } from "react";
import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import type { Track, TabKey, UserProfile } from "../../types";
import { Sidebar } from "../Sidebar/Sidebar";
import { PlayerBar } from "../PlayerBar/PlayerBar";
import { QueuePanel } from "../PlayerBar/QueuePanel";

/**
 * Single source of truth for "a full-screen modal covers the shell".
 * AppShell uses it for inert/blur; App reuses the SAME predicate to hand
 * `isShellLocked` down to the Now Playing overlay, so the native video host
 * (which CSS cannot blur or clip) can never stay up behind a modal.
 * Extracted rather than duplicated because the two must not drift.
 */
export function isShellLocked(
  isLoggedIn: boolean,
  appRootFolder: string | null,
  showFolderSelection: boolean,
): boolean {
  return !isLoggedIn || !appRootFolder || showFolderSelection;
}

interface AppShellProps {
  isLoggedIn: boolean;
  appRootFolder: string | null;
  showFolderSelection: boolean;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  userProfile: UserProfile | null;
  onLogout: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  token: string | null;
  isNowPlayingOpen: boolean;
  currentTrack: Track | null;
  loadNonce: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: (isAutoSkip?: boolean) => void;
  onPrevTrack: () => void;
  isDownloading: boolean;
  playMode: "normal" | "shuffle" | "repeat-all" | "repeat-one";
  onTogglePlayMode: () => void;
  onSelectTrack: (track: Track) => void;
  onExpandNowPlaying: () => void;
  isQueueOpen: boolean;
  onToggleQueue: () => void;
  onCloseQueue: () => void;
  tabContent: ReactNode;
}

export function AppShell({
  isLoggedIn,
  appRootFolder,
  showFolderSelection,
  activeTab,
  onTabChange,
  userProfile,
  onLogout,
  isSidebarOpen,
  onToggleSidebar,
  token,
  isNowPlayingOpen,
  currentTrack,
  loadNonce,
  isPlaying,
  onTogglePlay,
  onNextTrack,
  onPrevTrack,
  isDownloading,
  playMode,
  onTogglePlayMode,
  onSelectTrack,
  onExpandNowPlaying,
  isQueueOpen,
  onToggleQueue,
  onCloseQueue,
  tabContent,
}: AppShellProps) {
  const { t } = useTranslation();

  // Shell lock: a full-screen modal covers the shell in these states —
  // LoginScreen (!isLoggedIn) or FolderSelectionGate
  // (isLoggedIn && (!appRootFolder || showFolderSelection), see the gate).
  // inert/aria-hidden keep keyboard/AT (and pointer) out of the blurred
  // shell behind the modal, mirroring the QueuePanel drawer pattern.
  const shellLocked = isShellLocked(
    isLoggedIn,
    appRootFolder,
    showFolderSelection,
  );

  return (
    // Shell grid: 2 columns × 2 rows. Row 1 = Sidebar (auto col) +
    // #content-area (1fr col); row 2 = the PlayerBar wrapper spanning both
    // columns (col-span-2), so the bar stretches the full window width while
    // Sidebar/Main give up vertical space above it — in flow, not absolute.
    // The blur/scale wrapper classes apply to the grid as a whole, so the
    // player also locks (aria-hidden/inert) with the shell behind a modal.
    <div
      aria-hidden={shellLocked}
      inert={shellLocked}
      className={`grid grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] flex-1 overflow-hidden transition-all duration-700 ease-in-out ${!isLoggedIn || (!appRootFolder && !showFolderSelection) ? "blur-xl scale-[0.97] opacity-40 pointer-events-none" : "blur-0 scale-100 opacity-100"}`}
    >
      <Sidebar
        activeTab={activeTab}
        onTabChange={onTabChange}
        userProfile={userProfile}
        onLogout={onLogout}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={onToggleSidebar}
        token={token}
      />

      <div id="content-area" className="relative overflow-hidden flex flex-col">
        {/* Row: tab content + queue pane side by side. The pane is an in-flow
            sibling (docked): opening it shrinks the list column
            (flex-1 min-w-0) instead of overlaying it, mirroring the sidebar
            on the other side; the row's overflow-hidden clips the pane's
            content while its width transition plays. */}
        <div className="flex-1 min-h-0 relative overflow-hidden flex">
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {/* Lazy tab chunks load on first visit — a compact blue spinner
                (the familiar pre-skeleton loading) instead of a heavy skeleton
                list: settings and other non-list tabs have no file rows to
                mirror, so a skeleton would just sit there unrelated. */}
            <Suspense
              fallback={
                <div
                  role="status"
                  aria-label={t("loading")}
                  className="flex-1 flex items-center justify-center"
                >
                  <LoaderCircle className="animate-spin h-10 w-10 text-brand-text stroke-[1.5]" />
                </div>
              }
            >
              {tabContent}
            </Suspense>
          </div>

          <QueuePanel
            open={isQueueOpen}
            onClose={onCloseQueue}
            onSelectTrack={onSelectTrack}
            activeTab={activeTab}
          />
        </div>
      </div>

      <div
        aria-hidden={isNowPlayingOpen}
        inert={isNowPlayingOpen}
        className={`transition-all duration-700 ease-in-out col-span-2 ${isNowPlayingOpen ? "h-0 overflow-hidden pointer-events-none opacity-0" : ""}`}
      >
        <PlayerBar
          currentTrack={currentTrack}
          loadNonce={loadNonce}
          isPlaying={isPlaying}
          onTogglePlay={onTogglePlay}
          onNextTrack={onNextTrack}
          onPrevTrack={onPrevTrack}
          isDownloading={isDownloading}
          playMode={playMode}
          onTogglePlayMode={onTogglePlayMode}
          onSelectTrack={onSelectTrack}
          onExpandNowPlaying={onExpandNowPlaying}
          isQueueOpen={isQueueOpen}
          onToggleQueue={onToggleQueue}
        />
      </div>
    </div>
  );
}
