import { useState } from "react";
import { useTranslation } from "react-i18next";

interface UserProfileLike {
  name: string;
  email: string;
  picture: string;
}

interface UserAvatarProps {
  userProfile?: UserProfileLike | null | undefined;
}

// Shared avatar circle extracted from the Sidebar's UserProfileSection
// (Task 13 mobile-polish): the Settings mobile header renders the same
// identity image with the same fallbacks — picture onError -> initial
// letter, no profile -> "?" guest. Markup is byte-identical to the
// pre-extraction Sidebar branch; only the layout wrapper (ml-1/shrink-0)
// stays at the call site.
export function UserAvatar({ userProfile }: UserAvatarProps) {
  const { t } = useTranslation();
  const [avatarFailed, setAvatarFailed] = useState(false);

  if (userProfile) {
    if (avatarFailed) {
      return (
        <div className="w-10 h-10 rounded-full bg-brand-primary/20 flex items-center justify-center">
          <span className="text-brand-primary font-bold">
            {userProfile.name.charAt(0).toUpperCase()}
          </span>
        </div>
      );
    }
    return (
      <img
        src={userProfile.picture}
        alt={t("common.profile_alt")}
        referrerPolicy="no-referrer"
        onError={() => {
          setAvatarFailed(true);
        }}
        className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 object-cover"
      />
    );
  }

  return (
    <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
      <span className="text-gray-400 font-bold">?</span>
    </div>
  );
}
