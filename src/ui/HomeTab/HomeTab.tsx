import { useState } from "react";
import type { Track } from "../../types";
import type { UserProfile } from "../../types";
import { Clock, Sparkles, Folder, Repeat, PlusCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HomeSection, SectionSkeleton } from "./components/HomeSection";
import { PremiumGrid } from "./components/PremiumGrid";
import { FullRecentView } from "./components/FullRecentView";
import { RecentFolderCard } from "./RecentFolderCard";
import { useHomeData } from "./useHomeData";
import { useHardwareBack } from "../../hooks/useHardwareBack";
import { useResponsiveItems } from "../../hooks/useResponsiveItems";
import { IS_MOBILE } from "../../utils/platform";
import {
  Skeleton,
  SkeletonCardGrid,
  SkeletonRowList,
} from "../components/Skeleton";

export function HomeTab({
  onPlay,
  onOpenFolder,
  token,
  userProfile,
  currentTrack,
  isActive = true,
}: {
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  onOpenFolder: (id: string, name: string) => void;
  token: string | null;
  userProfile?: UserProfile | null;
  currentTrack?: Track | null;
  isActive?: boolean;
}) {
  const { t } = useTranslation();
  const {
    recent,
    heavy,
    discover,
    mostVisitedFolders,
    recentlyAdded,
    greeting,
    subtitle,
  } = useHomeData(token, isActive);

  const [showFullRecent, setShowFullRecent] = useState(false);
  // Independent from showFullRecent: the two full views are mutually exclusive
  // by construction (each grid card routes to exactly one of them), and keeping
  // separate states means Back never has to guess which view it closes.
  const [showFullRecentlyAdded, setShowFullRecentlyAdded] = useState(false);

  // Task 14 mobile-polish: the full recent view is a LIFO navigation layer —
  // hardware back closes it BEFORE the app-level chain (NowPlaying → tab →
  // double-back-to-exit). State is local to HomeTab, so the handler registers
  // here, reusing the same setters as the FullRecentView onBack prop. Gated on
  // isActive: HomeTab is keep-alive (hidden via display:none on other tabs),
  // and a hidden view must never swallow back presses meant for the visible
  // tab. Registered as a CHILD effect it sits BEFORE App's overlay handlers in
  // the handler array, so handleGlobalBack (LIFO, last-first) still closes
  // overlays first — matching the Android navigation stack order.
  useHardwareBack(
    () => {
      if (showFullRecent) {
        setShowFullRecent(false);
      } else if (showFullRecentlyAdded) {
        setShowFullRecentlyAdded(false);
      }
      return true;
    },
    isActive && (showFullRecent || showFullRecentlyAdded),
  );

  const visibleCount = useResponsiveItems();

  if (showFullRecent) {
    return (
      <FullRecentView
        recent={recent ?? []}
        onBack={() => {
          setShowFullRecent(false);
        }}
        onPlay={onPlay}
        token={token}
        currentTrack={currentTrack}
      />
    );
  }

  if (showFullRecentlyAdded) {
    return (
      <FullRecentView
        recent={recentlyAdded ?? []}
        title={t("home.recently_added")}
        onBack={() => {
          setShowFullRecentlyAdded(false);
        }}
        onPlay={onPlay}
        token={token}
        currentTrack={currentTrack}
      />
    );
  }

  const quickAccess = (recent ?? []).slice(0, visibleCount);
  const discoverItems =
    (discover ?? []).length > 0 ? (discover ?? []).slice(0, visibleCount) : [];
  const heavyItems =
    (heavy ?? []).length > 0 ? (heavy ?? []).slice(0, visibleCount) : [];
  const recentlyAddedItems =
    (recentlyAdded ?? []).length > 0
      ? (recentlyAdded ?? []).slice(0, visibleCount)
      : [];

  return (
    <main className="flex-1 bg-white dark:bg-[#0A0A0A] overflow-y-auto custom-scrollbar transition-colors duration-300">
      <div className="max-w-6xl mx-auto p-8 pb-32">
        {recent === null ? (
          <div data-testid="home-greeting-skeleton" className="space-y-2 mb-10">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-40" />
          </div>
        ) : (
          <header className="mb-10 mt-4 flex flex-col gap-1">
            <h2
              className={`${IS_MOBILE ? "text-xl" : "text-3xl"} font-bold tracking-tight text-gray-900 dark:text-white`}
            >
              {greeting}
              {userProfile?.name
                ? `, ${userProfile.name.split(" ")[0] ?? ""}`
                : ""}
            </h2>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
              {subtitle}
            </p>
          </header>
        )}

        {/* QUICK ACCESS: Sleek List View */}
        {recent === null ? (
          <SectionSkeleton>
            <Skeleton className="h-4 w-32 mb-4" />
            <SkeletonCardGrid rows={1} cols={visibleCount} />
          </SectionSkeleton>
        ) : quickAccess.length > 0 ? (
          <HomeSection
            icon={Clock}
            title={t("home.recent_files")}
            justifyBetween
          >
            <PremiumGrid
              items={quickAccess}
              onPlay={onPlay}
              token={token}
              isOverlay={(_track, index) =>
                index === visibleCount - 1 && recent.length > visibleCount
              }
              onOverlayClick={() => {
                setShowFullRecent(true);
              }}
            />
          </HomeSection>
        ) : null}

        {/* RECENTLY ADDED TO DRIVE */}
        {recentlyAdded === null ? (
          <SectionSkeleton>
            <Skeleton className="h-4 w-32 mb-4" />
            <SkeletonCardGrid rows={1} cols={visibleCount} />
          </SectionSkeleton>
        ) : recentlyAdded.length > 0 ? (
          <HomeSection
            icon={PlusCircle}
            title={t("home.recently_added")}
            justifyBetween
          >
            {/* Mirror of the Recent Files overlay contract, with one
                deliberate difference: `>=` instead of `>`. The list is
                capped at the mirror query's limit (100), so a list exactly
                as long as the grid (e.g. 5 == visibleCount on desktop)
                means more files may exist behind it, and the last card must
                open the full view. Recent Files keeps `>`: its data is an
                unbounded local history slice. */}
            <PremiumGrid
              items={recentlyAddedItems}
              onPlay={onPlay}
              token={token}
              isOverlay={(_track, index) =>
                index === visibleCount - 1 &&
                recentlyAdded.length >= visibleCount
              }
              onOverlayClick={() => {
                setShowFullRecentlyAdded(true);
              }}
            />
          </HomeSection>
        ) : null}

        {/* JUMP BACK IN: Most Visited Folders */}
        {mostVisitedFolders === null ? (
          <SectionSkeleton>
            <Skeleton className="h-4 w-32 mb-4" />
            <SkeletonRowList
              rows={4}
              variant="folder"
              containerClassName="grid grid-cols-2 md:grid-cols-4 gap-4"
            />
          </SectionSkeleton>
        ) : mostVisitedFolders.length > 0 ? (
          <HomeSection icon={Folder} title={t("home.jump_back_in")}>
            {/* Task 7: no View All -> mobile horizontal snap strip (fixed
                touch-width items), desktop keeps the grid untouched. */}
            <div
              className={
                IS_MOBILE
                  ? "flex overflow-x-auto snap-x snap-mandatory gap-4"
                  : "grid grid-cols-2 md:grid-cols-4 gap-4"
              }
            >
              {mostVisitedFolders.map((folder) => (
                <RecentFolderCard
                  key={folder.id}
                  folder={folder}
                  onOpenFolder={onOpenFolder}
                />
              ))}
            </div>
          </HomeSection>
        ) : null}

        {/* HEAVY ROTATION */}
        {heavy === null ? (
          <SectionSkeleton>
            <Skeleton className="h-4 w-32 mb-4" />
            <SkeletonCardGrid rows={1} cols={visibleCount} />
          </SectionSkeleton>
        ) : heavyItems.length > 0 ? (
          <HomeSection icon={Repeat} title={t("home.heavy_rotation")}>
            {/* Task 7: no View All -> mobile horizontal snap strip. */}
            <PremiumGrid
              items={heavyItems}
              onPlay={onPlay}
              token={token}
              scrollable
            />
          </HomeSection>
        ) : null}

        {/* DISCOVER: Premium Cards */}
        {discover === null ? (
          <SectionSkeleton>
            <Skeleton className="h-4 w-32 mb-4" />
            <SkeletonCardGrid rows={1} cols={visibleCount} />
          </SectionSkeleton>
        ) : discoverItems.length > 0 ? (
          <HomeSection icon={Sparkles} title={t("home.discover")}>
            {/* Task 7: no View All -> mobile horizontal snap strip. */}
            <PremiumGrid
              items={discoverItems}
              onPlay={onPlay}
              token={token}
              scrollable
            />
          </HomeSection>
        ) : null}
      </div>
    </main>
  );
}
