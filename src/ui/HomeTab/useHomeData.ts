import { useEffect, useState, useMemo, useRef } from "react";
import type { Track } from "../../types";
import type { FolderVisitEntry } from "../../utils/history";
import {
  getRecentlyPlayed,
  getHeavyRotation,
  getRandomDiscoveries,
  getMostVisitedFolders,
} from "../../utils/history";
import { db } from "../../db/db";
import { getCurrentUserEmail } from "../../utils/storageKeys";
import { hasAudioExtension } from "../../utils/audioQuery";
import { SYNC_EVENT_NAMES } from "../../utils/proSyncManager";
import { prefetchVisibleTracks } from "../../utils/streamPrefetcher";
import { DRIVE_FILES_CHANGED_EVENT } from "../../utils/upload/errors";
import rawGreetingsData from "../../data/greetings.json";
import { useTranslation } from "react-i18next";
import { captureError } from "../../utils/errorLog";
import { DEBUG_EVENTS, onDebugEvent } from "../debug/debugEvents";

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

// "Recently Added to Drive" cap. Bounds the rendered list and must exceed
// every responsive grid count (2/4/5) so the grid can always tell "list is
// full → more files may exist" apart from "list really is that short"
// (the overlay contract in HomeTab.tsx keys off `>=` visibleCount).
const RECENTLY_ADDED_LIMIT = 100;

// Data + greeting layer of the Home tab, extracted verbatim from HomeTab.tsx.
// Pure hook — all JSX/render stays in HomeTab.tsx (the public facade), so the
// export path and rendered DOM are untouched. The full-view navigation state
// (showFullRecent/showFullRecentlyAdded) stays in HomeTab.tsx because it is
// view-layer state.
export function useHomeData(token: string | null) {
  const { t, i18n } = useTranslation();
  // null = first load still in flight (skeleton); [] = genuinely empty.
  const [recent, setRecent] = useState<Track[] | null>(null);
  const [heavy, setHeavy] = useState<Track[] | null>(null);
  const [discover, setDiscover] = useState<Track[] | null>(null);
  const [mostVisitedFolders, setMostVisitedFolders] = useState<
    FolderVisitEntry[] | null
  >(null);
  const [recentlyAdded, setRecentlyAdded] = useState<Track[] | null>(null);
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

    // Reads the local IDB mirror (db.files) instead of the Drive API: the
    // mirror is maintained by fullSync/deltaSync and updated incrementally as
    // new files arrive, so this section loads instantly like the four other
    // local sections instead of waiting on a multi-second Drive round trip.
    // Rows carry the same ISO modifiedTime strings Drive reports, so a plain
    // lexicographic desc sort orders newest-first; missing modifiedTime sorts
    // oldest. The null-token guard stays: logged-out means no Recently Added.
    const loadRecentlyAdded = (activeToken: string | null): void => {
      if (!activeToken) return;
      const generation = ++loadGenRef.current;
      db.files
        .where("userEmail")
        .equals(getCurrentUserEmail())
        .toArray()
        .then((rows) => {
          if (generation !== loadGenRef.current) return;
          setRecentlyAdded(
            rows
              .filter(
                (row) =>
                  !row.isFolder && !row.trashed && hasAudioExtension(row.name),
              )
              .sort((a, b) => {
                const at = a.modifiedTime ?? "";
                const bt = b.modifiedTime ?? "";
                if (at !== bt) return bt.localeCompare(at);
                return a.id.localeCompare(b.id);
              })
              .slice(0, RECENTLY_ADDED_LIMIT)
              .map((row) => ({
                id: row.id,
                title: row.name,
                artist: "",
                streamUrl: "",
                originalName: row.name,
                size: row.size,
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

  return {
    recent,
    heavy,
    discover,
    mostVisitedFolders,
    recentlyAdded,
    greeting,
    subtitle,
  };
}
