import { LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../../components/UserAvatar";
import type { UserProfile } from "../../../types";

interface MobileUserHeaderProps {
  userProfile?: UserProfile | null | undefined;
  onLogout: () => void;
}

export function MobileUserHeader({
  userProfile,
  onLogout,
}: MobileUserHeaderProps) {
  const { t } = useTranslation();
  return (
    // Task 13 mobile-polish: user identity header on mobile — avatar +
    // name + email, fed from the same userProfile prop the Sidebar
    // renders from (no second fetch). Desktop stays byte-identical:
    // no header markup at all.
    <div className="flex items-center gap-4 mb-8">
      <div className="ml-1 shrink-0 flex items-center justify-center">
        <UserAvatar userProfile={userProfile} />
      </div>
      <div className="overflow-hidden whitespace-nowrap flex flex-col justify-center">
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
      <button
        onClick={onLogout}
        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors shrink-0 ml-auto"
        title={t("sidebar.log_out")}
      >
        <LogOut className="w-4 h-4" />
      </button>
    </div>
  );
}
