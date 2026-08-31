import { HardDrive, Home, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TABS, type TabKey } from "../../utils/driveConstants";

interface BottomNavProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

// Mobile-only primary navigation (Task 11): mirrors the Sidebar's static
// destinations — Home / My Drive / Settings.
// Only rendered by AppShell when IS_MOBILE; desktop keeps the Sidebar.
export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  const { t } = useTranslation();

  const items = [
    {
      key: TABS.home,
      label: t("sidebar.home"),
      icon: Home,
      active: activeTab === TABS.home,
    },
    {
      key: TABS.myDrive,
      label: t("sidebar.my_drive"),
      icon: HardDrive,
      active: activeTab === TABS.myDrive,
    },
    {
      key: TABS.settings,
      label: t("sidebar.settings"),
      icon: Settings,
      active: activeTab === TABS.settings,
    },
  ] as const;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 flex h-14 items-stretch justify-around border-t border-gray-200/50 bg-[#F8F9FA] px-2 pb-[env(safe-area-inset-bottom)] dark:border-gray-800/50 dark:bg-[#121212]">
      {items.map(({ key, label, icon: Icon, active }) => (
        <button
          key={key}
          type="button"
          onClick={() => {
            onTabChange(key);
          }}
          aria-current={active ? "page" : undefined}
          className={`flex flex-1 flex-col items-center justify-center transition-colors ${active ? "text-brand-primary" : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"}`}
        >
          <Icon
            className={`h-5 w-5 transition-transform duration-200 ${active ? "scale-110" : ""}`}
          />
          <span className="w-full truncate text-center text-[10px] font-medium">
            {label}
          </span>
        </button>
      ))}
    </nav>
  );
}
