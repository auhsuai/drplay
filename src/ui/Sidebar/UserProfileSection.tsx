import { Settings, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TABS, type TabKey } from "../../utils/driveConstants";
import { NavItem } from "./NavItem";
import { UserAvatar } from "../components/UserAvatar";

interface UserProfileSectionProps {
  userProfile?:
    { name: string; email: string; picture: string } | null | undefined;
  onLogout?: (() => void) | undefined;
  isSidebarOpen: boolean;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

export function UserProfileSection({
  userProfile,
  onLogout,
  isSidebarOpen,
  activeTab,
  onTabChange,
}: UserProfileSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="p-4">
      <NavItem
        icon={<Settings />}
        label={t("sidebar.settings")}
        active={activeTab === TABS.settings}
        onClick={() => {
          onTabChange(TABS.settings);
        }}
        isSidebarOpen={isSidebarOpen}
      />

      <div className="mt-4 pt-4 flex items-center transition-all duration-300">
        <div className="ml-1 shrink-0 flex items-center justify-center">
          <UserAvatar userProfile={userProfile} />
        </div>

        <div
          className={`overflow-hidden transition-all duration-300 whitespace-nowrap flex flex-col justify-center ${isSidebarOpen ? "max-w-[150px] opacity-100 ml-3" : "max-w-0 opacity-0 ml-0"}`}
        >
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {userProfile ? userProfile.name : t("sidebar.guest")}
          </p>
          <p
            className="text-xs text-gray-500 truncate"
            title={userProfile?.email || ""}
          >
            {userProfile ? userProfile.email : t("sidebar.not_authenticated")}
          </p>
        </div>

        {onLogout && (
          <div
            className={`overflow-hidden transition-all duration-300 flex items-center ${isSidebarOpen ? "max-w-[40px] opacity-100 ml-auto" : "max-w-0 opacity-0"}`}
          >
            <button
              onClick={onLogout}
              className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors shrink-0"
              title={t("sidebar.log_out")}
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
