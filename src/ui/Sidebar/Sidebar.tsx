import { Home, HardDrive, Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TABS, type TabKey } from "../../utils/driveConstants";
import { DropZone } from "../components/DropZone";
import { NavItem } from "./NavItem";
import { SidebarHeader } from "./SidebarHeader";
import { PlaylistSection } from "./PlaylistSection";
import { StorageQuotaCard } from "./StorageQuotaCard";
import { UserProfileSection } from "./UserProfileSection";

interface SidebarProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  userProfile?: { name: string; email: string; picture: string } | null;
  onLogout?: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  token?: string | null;
}

export type { SidebarProps };

export function Sidebar({
  activeTab,
  onTabChange,
  onLogout,
  userProfile,
  isSidebarOpen,
  onToggleSidebar,
  token,
}: SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside
      className={`${isSidebarOpen ? "w-64" : "w-20"} bg-[#F8F9FA] dark:bg-[#121212] h-full flex flex-col shrink-0 transition-all duration-300 overflow-hidden border-r border-gray-200/50 dark:border-gray-800/50`}
    >
      <SidebarHeader
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={onToggleSidebar}
        token={token}
        activeTab={activeTab}
      />
      <nav className="px-4 space-y-1 mb-2">
        <NavItem
          icon={<Home />}
          label={t("sidebar.home")}
          active={activeTab === TABS.home}
          onClick={() => {
            onTabChange(TABS.home);
          }}
          isSidebarOpen={isSidebarOpen}
        />
        <NavItem
          icon={<HardDrive />}
          label={t("sidebar.my_drive")}
          active={activeTab === TABS.myDrive}
          onClick={() => {
            onTabChange(TABS.myDrive);
          }}
          isSidebarOpen={isSidebarOpen}
        />
        <NavItem
          icon={<Heart />}
          label={t("sidebar.liked_songs")}
          active={activeTab === TABS.likedSongs}
          onClick={() => {
            onTabChange(TABS.likedSongs);
          }}
          isSidebarOpen={isSidebarOpen}
        />
      </nav>
      <PlaylistSection
        onTabChange={onTabChange}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={onToggleSidebar}
        activeTab={activeTab}
      />
      <StorageQuotaCard token={token} isSidebarOpen={isSidebarOpen} />
      <UserProfileSection
        userProfile={userProfile}
        onLogout={onLogout}
        isSidebarOpen={isSidebarOpen}
        activeTab={activeTab}
        onTabChange={onTabChange}
      />
      <DropZone token={token} />
    </aside>
  );
}
