import type { ReactNode } from "react";
import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import type { Track, TabKey, UserProfile } from "../../types";
import { IS_MOBILE } from "../../utils/platform";
import { Sidebar } from "../Sidebar/Sidebar";
import { PlayerBar } from "../PlayerBar/PlayerBar";
import { BottomNav } from "../components/BottomNav";

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
  onExpandNowPlaying: () => void;
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
  onExpandNowPlaying,
  tabContent,
}: AppShellProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`flex flex-1 overflow-hidden transition-all duration-700 ease-in-out ${!isLoggedIn || (!appRootFolder && !showFolderSelection) ? "blur-xl scale-[0.97] opacity-40 pointer-events-none" : "blur-0 scale-100 opacity-100"}`}
    >
      {/* Mobile (Task 11): the Sidebar stays MOUNTED (login state, playlist
          scroll etc. are never reset) — only its wrapper is display:hidden;
          `contents` on desktop keeps the aside a direct flex child exactly
          as before (zero layout change). */}
      <div className={IS_MOBILE ? "hidden" : "contents"}>
        <Sidebar
          activeTab={activeTab}
          onTabChange={onTabChange}
          userProfile={userProfile}
          onLogout={onLogout}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={onToggleSidebar}
          token={token}
        />
      </div>

      <div
        id="content-area"
        className={`flex-1 relative overflow-hidden flex flex-col ${IS_MOBILE ? "pb-[calc(env(safe-area-inset-bottom)+4rem)]" : ""}`}
      >
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
              <LoaderCircle className="animate-spin h-10 w-10 text-brand-primary stroke-[1.5]" />
            </div>
          }
        >
          {tabContent}
        </Suspense>

        <div
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
            onExpandNowPlaying={onExpandNowPlaying}
          />
        </div>
      </div>

      {/* Mobile primary navigation — reuses the SAME onTabChange handler as
          the Sidebar (App.handleTabChange): one source of truth per tab
          switch, including the My-Drive re-root logic. Fixed bottom so it
          stays above the safe-area; content-area carries matching padding. */}
      {IS_MOBILE && (
        <BottomNav activeTab={activeTab} onTabChange={onTabChange} />
      )}
    </div>
  );
}
