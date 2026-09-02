import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "./hooks/useTheme";
import { LoginGate } from "./ui/LoginGate";
import { FolderSelectionGate } from "./ui/FolderSelectionGate";
import { TrashGate } from "./ui/TrashGate";
import { NowPlayingOverlay } from "./ui/NowPlayingOverlay";
import { RateLimitGate } from "./ui/RateLimitGate";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB, TABS } from "./utils/driveConstants";
import { TabContentRouter } from "./ui/layouts/TabContentRouter";
import { AppShell } from "./ui/layouts/AppShell";

import "./App.css";

import { saveSidebarOpenState } from "./utils/sidebarState";

import { resumeInterruptedUploads } from "./utils/uploadManager";
import { getCurrentUserEmail } from "./utils/storageKeys";

import { useRateLimitGate } from "./hooks/useRateLimitGate";
import { useAppAuth } from "./hooks/useAppAuth";
import { useAppGlobalEvents } from "./hooks/useAppGlobalEvents";
import { useAppDriveState } from "./hooks/useAppDriveState";
import { useAppPlayer } from "./hooks/useAppPlayer";
import { useAppUiState } from "./hooks/useAppUiState";
import { useAppBackNavigation } from "./hooks/useAppBackNavigation";

import type { Track, UserProfile, TabKey } from "./types";
export type { Track, UserProfile };

function App() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>(TABS.home);
  const { theme, setTheme } = useTheme();

  // Rate-limit modal state + its two triggers (Tauri event + DEV debug).
  const { showRateLimitModal, setShowRateLimitModal } = useRateLimitGate();

  const {
    isLoggedIn,
    accessToken,
    userProfile,
    handleLoginSuccess,
    handleLogout,
    setAppRootFolderRef,
  } = useAppAuth();

  // Global window events (focus refresh, contextmenu). Logout via the
  // 'auth-logout' event is handled internally by useAuth.
  useAppGlobalEvents();

  const {
    appRootFolder,
    setAppRootFolder,
    currentFolderId,
    setCurrentFolderId,
    currentFolderName,
    setCurrentFolderName,
    folderHistory,
    setFolderHistory,
    sortOption,
    setSortOption,
    handleOpenFolder,
    handleBack,
    handleBreadcrumbClick,
    handleSelectRootFolder,
    isLoadingTracks,
    highlightedFileId,
  } = useAppDriveState(isLoggedIn, accessToken, setActiveTab);

  const {
    currentTrack,
    isPlaying,
    isDownloading,
    playMode,
    handlePlayTrack,
    loadNonce,
    stableHandleTogglePlay,
    stableHandleNextTrack,
    stableHandlePrevTrack,
    stableHandleTogglePlayMode,
  } = useAppPlayer(accessToken, activeTab);

  const {
    showTrashScreen,
    setShowTrashScreen,
    showFolderSelection,
    setShowFolderSelection,
    isSidebarOpen,
    setIsSidebarOpen,
    isNowPlayingOpen,
    setIsNowPlayingOpen,
    backgroundPlayback,
    setBackgroundPlayback,
    onExpandNowPlaying,
  } = useAppUiState();

  useEffect(() => {
    setAppRootFolderRef.current = setAppRootFolder;
  }, [setAppRootFolder, setAppRootFolderRef]);

  const handleTabChange = useCallback(
    (tab: TabKey) => {
      if (activeTab === tab && tab === TABS.myDrive) {
        setCurrentFolderId(appRootFolder || ROOT_FOLDER_ID);
        setCurrentFolderName(MY_DRIVE_TAB);
        setFolderHistory([]);
      }
      setActiveTab(tab);
    },
    [
      activeTab,
      appRootFolder,
      setCurrentFolderId,
      setCurrentFolderName,
      setFolderHistory,
    ],
  );

  useAppBackNavigation({
    activeTab,
    handleTabChange,
    t,
    folderHistory,
    handleBack,
    appRootFolder,
    currentFolderId,
    setCurrentFolderId,
    setCurrentFolderName,
    isSidebarOpen,
    setIsSidebarOpen,
    showFolderSelection,
    setShowFolderSelection,
    showTrashScreen,
    setShowTrashScreen,
    showRateLimitModal,
    setShowRateLimitModal,
    isNowPlayingOpen,
    setIsNowPlayingOpen,
  });

  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-white dark:bg-[#121212] transition-colors duration-300">
      {/* Login Overlay */}
      <LoginGate
        isLoggedIn={isLoggedIn}
        onLogin={(tokens) => {
          handleLoginSuccess({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in,
          });
          // Fire-and-forget: resumeInterruptedUploads guards itself against
          // double-runs and never rejects (every step is caught inside — a
          // failure only surfaces as a warn log and/or the aggregated
          // interrupted toast). getCurrentUserEmail is the SAME source the
          // manager persists session rows under, so the scan always queries
          // the exact key the interrupted rows were written with.
          void resumeInterruptedUploads(
            tokens.access_token,
            getCurrentUserEmail(),
          );
        }}
      />

      {/* Folder Selection Overlay */}
      <FolderSelectionGate
        isLoggedIn={isLoggedIn}
        appRootFolder={appRootFolder}
        showFolderSelection={showFolderSelection}
        token={accessToken}
        onSelectFolder={(folderId) => {
          // Fire-and-forget: useDrive's handleSelectRootFolder handles its
          // own errors (each step is try/caught inside).
          void handleSelectRootFolder(folderId);
          setShowFolderSelection(false);
        }}
        onCancel={
          appRootFolder
            ? () => {
                setShowFolderSelection(false);
              }
            : undefined
        }
      />

      <TrashGate
        showTrashScreen={showTrashScreen}
        token={accessToken}
        onClose={() => {
          setShowTrashScreen(false);
        }}
      />

      <AppShell
        isLoggedIn={isLoggedIn}
        appRootFolder={appRootFolder}
        showFolderSelection={showFolderSelection}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        userProfile={userProfile}
        onLogout={() => {
          // Fire-and-forget: useAuth's handleLogout handles its own errors.
          void handleLogout();
        }}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => {
          const nextOpen = !isSidebarOpen;
          setIsSidebarOpen(nextOpen);
          saveSidebarOpenState(nextOpen);
        }}
        token={accessToken}
        isNowPlayingOpen={isNowPlayingOpen}
        currentTrack={currentTrack}
        loadNonce={loadNonce}
        isPlaying={isPlaying}
        onTogglePlay={stableHandleTogglePlay}
        onNextTrack={stableHandleNextTrack}
        onPrevTrack={stableHandlePrevTrack}
        isDownloading={isDownloading}
        playMode={playMode}
        onTogglePlayMode={stableHandleTogglePlayMode}
        onExpandNowPlaying={onExpandNowPlaying}
        tabContent={
          <TabContentRouter
            activeTab={activeTab}
            isLoggedIn={isLoggedIn}
            userProfile={userProfile}
            token={accessToken}
            currentTrack={currentTrack}
            onPlayTrack={handlePlayTrack}
            onOpenFolder={handleOpenFolder}
            onSwitchTab={handleTabChange}
            isLoading={isLoadingTracks}
            onBack={handleBack}
            hasHistory={folderHistory.length > 0}
            folderHistory={folderHistory}
            currentFolderName={currentFolderName}
            currentFolderId={currentFolderId}
            onBreadcrumbClick={handleBreadcrumbClick}
            highlightedFileId={highlightedFileId}
            sortOption={sortOption}
            setSortOption={setSortOption}
            theme={theme}
            setTheme={setTheme}
            backgroundPlayback={backgroundPlayback}
            setBackgroundPlayback={setBackgroundPlayback}
            setShowFolderSelection={setShowFolderSelection}
            setShowTrashScreen={setShowTrashScreen}
            onLogout={() => {
              // Fire-and-forget: useAuth's handleLogout handles its own errors.
              void handleLogout();
            }}
          />
        }
      />

      {/* Now Playing Full Screen Overlay */}
      <NowPlayingOverlay
        isOpen={isNowPlayingOpen}
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        isDownloading={isDownloading}
        loadNonce={loadNonce}
        onTogglePlay={stableHandleTogglePlay}
        onNextTrack={stableHandleNextTrack}
        onPrevTrack={stableHandlePrevTrack}
        playMode={playMode}
        onTogglePlayMode={stableHandleTogglePlayMode}
        onBack={() => {
          setIsNowPlayingOpen(false);
        }}
        token={accessToken}
      />

      <RateLimitGate
        isOpen={showRateLimitModal}
        onClose={() => {
          setShowRateLimitModal(false);
        }}
        onOk={() => {
          setShowRateLimitModal(false);
          handleTabChange(TABS.home);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </div>
  );
}

export default App;
