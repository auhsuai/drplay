import type { ReactNode } from "react";
import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import type { Track, TabKey, UserProfile } from "../../types";
import { Sidebar } from "../Sidebar/Sidebar";
import { PlayerBar } from "../PlayerBar/PlayerBar";
import { QueuePanel } from "../PlayerBar/QueuePanel";

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
  const isShellLocked = !isLoggedIn || !appRootFolder || showFolderSelection;

  return (
    <div
      aria-hidden={isShellLocked}
      inert={isShellLocked}
      className={`flex flex-1 overflow-hidden transition-all duration-700 ease-in-out ${!isLoggedIn || (!appRootFolder && !showFolderSelection) ? "blur-xl scale-[0.97] opacity-40 pointer-events-none" : "blur-0 scale-100 opacity-100"}`}
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

      <div
        id="content-area"
        className="flex-1 relative overflow-hidden flex flex-col"
      >
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

        <div
          aria-hidden={isNowPlayingOpen}
          inert={isNowPlayingOpen}
          className={`transition-all duration-700 ease-in-out shrink-0 ${isNowPlayingOpen ? "h-0 overflow-hidden pointer-events-none opacity-0" : ""}`}
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
    </div>
  );
}
