import React from "react";
import { useTranslation } from "react-i18next";
import type { Track, TabKey, UserProfile } from "../../types";
import type { ThemeType } from "../../hooks/useTheme";
import { TABS } from "../../utils/driveConstants";
import { captureError } from "../../utils/errorLog";
import { LS_SORT_OPTION } from "../../appUiState";

const MainContent = React.lazy(() =>
  import("../MainContent/MainContent").then((module) => ({
    default: module.MainContent,
  })),
);
const HomeTab = React.lazy(() =>
  import("../HomeTab/HomeTab").then((module) => ({
    default: module.HomeTab,
  })),
);
const LikedSongs = React.lazy(() =>
  import("../LikedSongs/LikedSongs").then((module) => ({
    default: module.LikedSongs,
  })),
);
const PlaylistView = React.lazy(() =>
  import("../Playlist/PlaylistView").then((module) => ({
    default: module.PlaylistView,
  })),
);
const SettingsTab = React.lazy(() =>
  import("../Settings/SettingsTab").then((module) => ({
    default: module.SettingsTab,
  })),
);

interface TabContentRouterProps {
  activeTab: TabKey;
  isLoggedIn: boolean;
  userProfile: UserProfile | null;
  token: string | null;
  currentTrack: Track | null;
  onPlayTrack: (track: Track, contextQueue?: Track[]) => void;
  onOpenFolder: (id: string, name: string) => void;
  onSwitchTab: (tab: TabKey) => void;
  isLoading: boolean;
  onBack: () => void;
  hasHistory: boolean;
  folderHistory: { id: string; name: string }[];
  currentFolderName: string;
  currentFolderId: string;
  onBreadcrumbClick: (id: string, name: string, index: number) => void;
  highlightedFileId: { id: string; ts: number } | null;
  sortOption: string;
  setSortOption: (val: string) => void;
  theme: ThemeType;
  setTheme: (t: ThemeType) => void;
  minimizeToTray: boolean;
  setMinimizeToTray: (minimize: boolean) => void;
  setShowFolderSelection: (val: boolean) => void;
  setShowTrashScreen: (val: boolean) => void;
}

export function TabContentRouter({
  activeTab,
  isLoggedIn,
  userProfile,
  token,
  currentTrack,
  onPlayTrack,
  onOpenFolder,
  onSwitchTab,
  isLoading,
  onBack,
  hasHistory,
  folderHistory,
  currentFolderName,
  currentFolderId,
  onBreadcrumbClick,
  highlightedFileId,
  sortOption,
  setSortOption,
  theme,
  setTheme,
  minimizeToTray,
  setMinimizeToTray,
  setShowFolderSelection,
  setShowTrashScreen,
}: TabContentRouterProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* HomeTab stays mounted across tab switches (keep-alive): hiding
          it with display:none instead of unmounting prevents the
          refetch-on-remount churn of every home data load
          (getRecentlyPlayed / getHeavyRotation / getRandomDiscoveries /
          getMostVisitedFolders / getRecentlyAddedAudioFiles) and keeps
          scroll/greeting state. The key forces a clean remount per login
          session: logout -> login must not reuse the previous account's
          HomeTab state. accessToken is deliberately NOT the key — it
          rotates on every refresh and would remount constantly. */}
      <div
        className={
          activeTab === TABS.home ? "flex-1 min-h-0 flex flex-col" : "hidden"
        }
      >
        <HomeTab
          key={isLoggedIn ? "session-in" : "session-out"}
          onPlay={(t: Track, c?: Track[]) => {
            onPlayTrack(t, c);
          }}
          onOpenFolder={(id, name) => {
            onOpenFolder(id, name);
            onSwitchTab(TABS.myDrive);
          }}
          token={token}
          userProfile={userProfile}
          currentTrack={currentTrack}
        />
      </div>
      {activeTab !== TABS.home &&
        (activeTab === TABS.myDrive ? (
          <MainContent
            activeTab={activeTab}
            onPlay={onPlayTrack}
            isLoading={isLoading}
            onOpenFolder={onOpenFolder}
            onBack={onBack}
            hasHistory={hasHistory}
            folderHistory={folderHistory}
            currentFolderName={currentFolderName}
            currentFolderId={currentFolderId}
            onBreadcrumbClick={onBreadcrumbClick}
            token={token}
            currentTrack={currentTrack}
            highlightedFileId={highlightedFileId}
            onRefresh={() => {
              /* No-op, sync runs in background */
            }}
            onRemoveItem={() => {
              /* useLiveQuery handles UI updates automatically now */
            }}
            sortOption={sortOption}
            onSortChange={(val) => {
              setSortOption(val);
              try {
                localStorage.setItem(LS_SORT_OPTION, val);
              } catch (err) {
                void captureError({
                  level: "warn",
                  source: "App",
                  message: `sort-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
                });
              }
            }}
          />
        ) : activeTab === TABS.likedSongs ? (
          <LikedSongs
            onPlay={(t: Track, c: Track[]) => {
              onPlayTrack(t, c);
            }}
            token={token}
            currentTrack={currentTrack}
          />
        ) : activeTab.startsWith("playlist_") ? (
          <PlaylistView
            playlistId={activeTab.replace("playlist_", "")}
            onPlay={(t: Track, c?: Track[]) => {
              onPlayTrack(t, c);
            }}
            onDelete={() => {
              onSwitchTab(TABS.home);
            }}
            currentTrack={currentTrack}
          />
        ) : activeTab === TABS.settings ? (
          <SettingsTab
            theme={theme}
            setTheme={setTheme}
            minimizeToTray={minimizeToTray}
            setMinimizeToTray={setMinimizeToTray}
            setShowFolderSelection={setShowFolderSelection}
            setShowTrashScreen={setShowTrashScreen}
          />
        ) : (
          <main className="flex-1 bg-white dark:bg-[#121212] overflow-y-auto flex items-center justify-center transition-colors duration-300">
            <h1 className="text-2xl text-gray-500">
              {t("common.coming_soon")}: {activeTab}
            </h1>
          </main>
        ))}
    </>
  );
}
