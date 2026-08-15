import { useEffect, useState, useRef, useMemo } from "react";
import type { Track } from "../../types";
import type { UserProfile } from "../../types";
import type { FolderVisitEntry } from "../../utils/history";
import {
  getRecentlyPlayed,
  getHeavyRotation,
  getRandomDiscoveries,
  getMostVisitedFolders,
} from "../../utils/history";
import { getRecentlyAddedAudioFiles } from "../../utils/driveApi";
import { SYNC_EVENT_NAMES } from "../../utils/proSyncManager";
import { prefetchVisibleTracks } from "../../utils/streamPrefetcher";
import { DRIVE_FILES_CHANGED_EVENT } from "../../utils/upload/errors";
import { Clock, Sparkles, Folder, Repeat, PlusCircle } from "lucide-react";
import rawGreetingsData from "../../data/greetings.json";
import { useTranslation } from "react-i18next";
import { HomeSection, SectionSkeleton } from "./components/HomeSection";
import { PremiumGrid } from "./components/PremiumGrid";
import { FullRecentView } from "./components/FullRecentView";
import { useResponsiveItems } from "../../hooks/useResponsiveItems";
import { IS_MOBILE } from "../../utils/platform";
import { captureError } from "../../utils/errorLog";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";
import {
  Skeleton,
  SkeletonCardGrid,
  SkeletonRowList,
} from "../components/Skeleton";

interface GreetingsEntry {
  en: string;
  vi: string;
}
const greetingsData = rawGreetingsData;

const HOME_TAB_MODULE = "HomeTab";
// Trailing-edge debounce window for the delta refresh (lodash
// `_.debounce(func, wait)` default semantics — fire once, `wait` ms after
// the LAST call of a burst; lodash/debounce.js 4.17.21: leading=false,
// trailing=true). uploadManager dispatches drive-files-changed once per
// completed file, so an N-file batch is N events in quick succession; 1000ms
// collapses the burst into ONE refetch fired 1s after the batch ends, while
// a single upload's result still appears promptly. A batch can never starve
// the trailing fire (no maxWait needed): an upload session terminates, so
// the last completion always starts the final timer.
const DELTA_REFRESH_DEBOUNCE_MS = 1000;

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
  const { t, i18n } = useTranslation();
  // null = first load still in flight (skeleton); [] = genuinely empty.
  const [recent, setRecent] = useState<Track[] | null>(null);
  const [heavy, setHeavy] = useState<Track[] | null>(null);
  const [discover, setDiscover] = useState<Track[] | null>(null);
  const [mostVisitedFolders, setMostVisitedFolders] = useState<
    FolderVisitEntry[] | null
  >(null);
  const [recentlyAdded, setRecentlyAdded] = useState<Track[] | null>(null);
  const [showFullRecent, setShowFullRecent] = useState(false);
  // Independent from showFullRecent: the two full views are mutually exclusive
  // by construction (each grid card routes to exactly one of them), and keeping
  // separate states means Back never has to guess which view it closes.
  const [showFullRecentlyAdded, setShowFullRecentlyAdded] = useState(false);
  // Guards the Recently Added refetch against overlapping responses:
  // uploadManager fires drive-files-changed once per completed file, so a
  // multi-file batch triggers overlapping fetches. Every call bumps the
  // generation and only the NEWEST call may write state — a slow stale
  // response must never clobber the fresh result. The same bump in the effect
  // cleanup also invalidates in-flight fetches after unmount.
  const recentlyAddedLoadGenRef = useRef(0);
  // Independent generation guard for the full loadData flow (recent/heavy/
  // discover/folders). Kept separate from recentlyAddedLoadGenRef so a delta
  // refresh (which only re-reads Recently Added) can never cancel an in-flight
  // loadData — only a NEWER loadData may. Bumped in the cleanup so a stale
  // flow cannot write state after unmount.
  const loadDataGenRef = useRef(0);
  // Pending trailing-debounce timer for the delta refresh; cancelled on
  // unmount so a queued refetch can never run after the component is gone.
  const deltaRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Read visit count + pick the random greeting object exactly ONCE per mount.
  // Reading sessionStorage and calling Math.random() inside useMemo caused the
  // subtitle to reshuffle on every render (incl. StrictMode double-invoke).
  // A lazy useState initializer keeps the impure reads out of the render path
  // (the compiler treats initializers as an allowed escape hatch) while still
  // running only once.
  const [randomGreeting] = useState<{ randomObj: GreetingsEntry }>(() => {
    const visitCount = parseInt(
      sessionStorage.getItem("drplay_home_visit") || "0",
      10,
    );
    // Cycle: Time-specific -> General -> General -> Time-specific ...
    const isTimeSpecific = visitCount % 3 === 0;
    const hour = new Date().getHours();
    let timeKey: "morning" | "afternoon" | "evening";
    if (hour < 12) timeKey = "morning";
    else if (hour < 18) timeKey = "afternoon";
    else timeKey = "evening";
    const possibleSubtitles = isTimeSpecific
      ? greetingsData[timeKey]
      : greetingsData.general;
    const randomObj = possibleSubtitles[
      Math.floor(Math.random() * possibleSubtitles.length)
    ] ??
      possibleSubtitles[0] ?? { en: "", vi: "" };
    return { randomObj };
  });

  const { greeting, subtitle } = useMemo(() => {
    const hour = new Date().getHours();
    let greetingText = "";
    if (hour < 12) {
      greetingText = t("home.good_morning");
    } else if (hour < 18) {
      greetingText = t("home.good_afternoon");
    } else {
      greetingText = t("home.good_evening");
    }

    const lang = i18n.language.startsWith("vi") ? "vi" : "en";
    const randomObj = randomGreeting.randomObj;
    const randomSubtitle = randomObj[lang] || randomObj["en"];

    return { greeting: greetingText, subtitle: randomSubtitle };
  }, [t, i18n.language, randomGreeting]);

  useEffect(() => {
    // The generation counters are shared between the loaders and the cleanup;
    // capture the (stable) ref objects once so the cleanup does not touch the
    // outer-scope refs directly (react-hooks/exhaustive-deps).
    const loadGenRef = recentlyAddedLoadGenRef;
    const loadDataRef = loadDataGenRef;
    const deltaTimerRef = deltaRefreshTimerRef;
    const visitCount = parseInt(
      sessionStorage.getItem("drplay_home_visit") || "0",
      10,
    );
    sessionStorage.setItem("drplay_home_visit", (visitCount + 1).toString());

    const loadRecentlyAdded = (activeToken: string | null): void => {
      if (!activeToken) return;
      const generation = ++loadGenRef.current;
      getRecentlyAddedAudioFiles(activeToken)
        .then((files) => {
          if (generation !== loadGenRef.current) return;
          setRecentlyAdded(
            files.map((f) => ({
              id: f.id,
              title: f.name,
              artist: "",
              streamUrl: "",
              originalName: f.name,
              size: f.size ? parseInt(f.size, 10) : undefined,
            })),
          );
        })
        .catch((err: unknown) => {
          if (generation !== loadGenRef.current) return;
          void captureError({
            level: "warn",
            source: HOME_TAB_MODULE,
            message: `failed-to-load-recently-added: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    };

    const loadData = async () => {
      const generation = ++loadDataRef.current;
      const recent = await getRecentlyPlayed();
      if (generation !== loadDataRef.current) return;
      setRecent(recent);
      const heavy = await getHeavyRotation();
      if (generation !== loadDataRef.current) return;
      setHeavy(heavy);
      const discover = await getRandomDiscoveries();
      if (generation !== loadDataRef.current) return;
      setDiscover(discover);
      const mostVisitedFolders = await getMostVisitedFolders();
      if (generation !== loadDataRef.current) return;
      setMostVisitedFolders(mostVisitedFolders);

      loadRecentlyAdded(token);
    };
    loadData().catch(
      (err: unknown) =>
        void captureError({
          level: "error",
          source: HOME_TAB_MODULE,
          message: `failed-to-load-home-data: ${err instanceof Error ? err.message : String(err)}`,
        }),
    );

    const handleUpdate = () => {
      void loadData().catch(
        (err: unknown) =>
          void captureError({
            level: "error",
            source: HOME_TAB_MODULE,
            message: `failed-to-load-home-data: ${err instanceof Error ? err.message : String(err)}`,
          }),
      );
    };
    // Delta sync: refresh ONLY the Recently Added section (light, no re-running
    // the heavy local loads). Fired by uploads completing in-app
    // (drive-files-changed) and by the proSync worker completing a background
    // poll (pro-sync-complete — the only way files added from OTHER devices/web
    // reach the UI without a reload). Both paths funnel through a trailing
    // debounce (see DELTA_REFRESH_DEBOUNCE_MS) so a burst of per-file events
    // collapses into a single refetch instead of jumping the list N times.
    // The initial load and 'recent-updated' (a user-driven full reload of all
    // sections) stay undebounced on purpose.
    const scheduleDeltaRefresh = () => {
      if (deltaTimerRef.current !== null) {
        clearTimeout(deltaTimerRef.current);
      }
      deltaTimerRef.current = setTimeout(() => {
        deltaTimerRef.current = null;
        loadRecentlyAdded(token);
      }, DELTA_REFRESH_DEBOUNCE_MS);
    };
    const handleDeltaRefresh = () => {
      scheduleDeltaRefresh();
    };
    window.addEventListener("recent-updated", handleUpdate);
    window.addEventListener(DRIVE_FILES_CHANGED_EVENT, handleDeltaRefresh);
    window.addEventListener(SYNC_EVENT_NAMES.complete, handleDeltaRefresh);
    return () => {
      window.removeEventListener("recent-updated", handleUpdate);
      window.removeEventListener(DRIVE_FILES_CHANGED_EVENT, handleDeltaRefresh);
      window.removeEventListener(SYNC_EVENT_NAMES.complete, handleDeltaRefresh);
      // Cancel a pending debounced delta refresh: no fetch may run after
      // unmount (a stale list write or a captureError with no UI left).
      if (deltaTimerRef.current !== null) {
        clearTimeout(deltaTimerRef.current);
        deltaTimerRef.current = null;
      }
      loadGenRef.current++;
      loadDataRef.current++;
    };
    // loadData/loadRecentlyAdded are effect-local closures; only `token`
    // (used by the recently-added fetch) can change the effect's behavior,
    // and re-running on token change re-registers the delta listeners with a
    // fresh closure. The ref-mutation in the cleanup is intentionally not a
    // dependency (refs are stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Spread without `?? []` would throw "null is not iterable" while any of
    // the five states is still null on the first load — prefetch must be
    // null-safe and only ever see real track arrays.
    const tracks = [
      ...(recent ?? []),
      ...(heavy ?? []),
      ...(discover ?? []),
      ...(recentlyAdded ?? []),
    ];
    if (tracks.length > 0) prefetchVisibleTracks(tracks);
  }, [recent, heavy, discover, recentlyAdded]);

  // DEV-only debug trigger (Ctrl+Shift+D panel → "Loading / MainContent"):
  // returns every section to its null = skeleton state (the same branch the
  // first load shows). HomeTab fetches internally, so the data states are the
  // only lever; the next mount (tab switch / session change) reloads it like a
  // fresh visit. onDebugEvent no-ops in production builds.
  useEffect(() => {
    return onDebugEvent(DEBUG_EVENTS.SKELETON, (detail) => {
      if (detail.target === "home") {
        setRecent(null);
        setHeavy(null);
        setDiscover(null);
        setMostVisitedFolders(null);
        setRecentlyAdded(null);
      }
    });
  }, []);

  // Block the WebView's default find dialog on Home: Home has no search box,
  // and the app's only other Ctrl+F handler (MyDrive's search focus) lives in
  // MainContent, which is mounted solely on the MyDrive tab. The guard MUST be
  // gated on isActive because HomeTab is keep-alive (TabContentRouter hides it
  // with display:none instead of unmounting) — an always-on listener would
  // swallow Ctrl+F on other tabs too, breaking MyDrive's search shortcut.
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isActive]);

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
              className={`${IS_MOBILE ? "text-2xl" : "text-3xl"} font-bold tracking-tight text-gray-900 dark:text-white`}
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
                capped at RECENTLY_ADDED_PAGE_SIZE (100), so a list exactly
                as long as the grid (e.g. 5 == visibleCount on desktop)
                means the API page was FULL — more files may exist behind
                it, and the last card must open the full view. Recent Files
                keeps `>`: its data is an unbounded local history slice. */}
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
              {mostVisitedFolders.map((folder) => {
                const card = (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      onOpenFolder(folder.id, folder.name);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenFolder(folder.id, folder.name);
                      }
                    }}
                    className="p-3.5 rounded-2xl transition-all duration-300 cursor-pointer flex items-center gap-4 active:scale-[0.98] group w-full bg-[#F8F9FA] dark:bg-[#202124] hover:bg-white dark:hover:bg-[#2a2b2f] hover:shadow-lg hover:shadow-black/5 hover:-translate-y-1"
                  >
                    <div className="relative w-12 h-12 rounded-lg flex items-center justify-center shrink-0 overflow-hidden transition-colors bg-amber-100 dark:bg-amber-900/30 text-amber-500">
                      <Folder className="w-6 h-6" fill="currentColor" />
                    </div>
                    <div className="overflow-hidden flex-1 flex flex-col justify-center">
                      <h3 className="font-semibold text-[15px] transition-colors truncate leading-tight mb-0.5 text-gray-800 dark:text-gray-200 group-hover:text-brand-primary">
                        {folder.name}
                      </h3>
                      <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-gray-400 mt-0.5 min-w-0">
                        <span className="truncate">{t("drive.folders")}</span>
                      </div>
                    </div>
                  </div>
                );
                // IS_MOBILE is a module constant per page load: the wrapper
                // only exists on mobile — desktop DOM stays byte-identical.
                return IS_MOBILE ? (
                  <div key={folder.id} className="shrink-0 snap-start w-56">
                    {card}
                  </div>
                ) : (
                  card
                );
              })}
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
