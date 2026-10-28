import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { db } from "../db/db";
import { MY_DRIVE_TAB } from "../utils/driveConstants";
import { type RootFolder } from "../utils/rootFolders";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import {
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  FOLDER_HISTORY_KEY,
  SORT_OPTION_KEY,
  DB_NAV_STATE_KEY,
  safeLocalStorageGet,
} from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";
import {
  parseNavHistory,
  readLocalRootState,
  readLocalVersionMarker,
} from "./driveInit/rootConfig";
import {
  buildFallbackNavTarget,
  computeNavResume,
  type NavTarget,
} from "./driveInit/navigationHistory";
import {
  invalidateListingCacheForCurrentAccount,
  persistRootListLocally,
} from "./driveInit/rootCache";
import { reconcileRemoteRoots } from "./driveInit/rootReconciliation";

interface UseDriveInitParams {
  accessToken: string | null;
  isLoggedIn: boolean;
  hydratedRef: RefObject<boolean>;
  /** Bumped by the gate's Retry action to re-run this exact init path. */
  reloadNonce?: number;
}

export const useDriveInit = ({
  accessToken,
  isLoggedIn,
  hydratedRef,
  reloadNonce = 0,
}: UseDriveInitParams) => {
  const {
    setAppRootFolder,
    setRootFolders,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setSortOption,
    setIsHydrated,
    setConfigError,
  } = useDriveStore(
    useShallow((state) => ({
      setAppRootFolder: state.setAppRootFolder,
      setRootFolders: state.setRootFolders,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
      setSortOption: state.setSortOption,
      setIsHydrated: state.setIsHydrated,
      setConfigError: state.setConfigError,
    })),
  );

  // P2-04-8: tracks whether the PREVIOUS effect run was for an active login
  // session, so a logged-out -> logged-in transition can be told apart from a
  // mid-session re-init (token rotation).
  const sessionActiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const isCancelled = () => cancelled;

    // B12-1: a re-init is a re-run on an already-hydrated mount (typically the
    // ~45' proactive token rotation). It must not re-gate nav persistence nor
    // re-apply the persisted nav snapshot: the user may have navigated while
    // the re-verify is in flight, and overwriting that would revert their
    // position (the gated window would also silently drop their saves).
    const isReInit = hydratedRef.current;
    if (!isReInit) {
      hydratedRef.current = false;
    }

    // P2-04-8: a NEW login session starts with isHydrated=false so the folder
    // gate waits for THIS run instead of reading appRootFolder=null (the
    // initial placeholder) as "no root configured". A mid-session re-init
    // (token rotation, B12-1) must NOT reset it: the previous root is kept, so
    // blanking the flag would only risk a gate blink on a no-root screen.
    const sessionActive = isLoggedIn && accessToken !== null;
    if (sessionActive && !sessionActiveRef.current) {
      setIsHydrated(false);
    }
    sessionActiveRef.current = sessionActive;

    // One snapshot read of the ordered list + legacy primary (module
    // `driveInit/rootConfig`): re-reads localStorage on every call so the race
    // guard sees the latest commit.
    const initApp = async () => {
      // Outer try/finally guarantees hydration always reaches a safe state.
      // Even if initApp throws unexpectedly, the `finally` flips hydratedRef
      // true (unless the effect was cleaned up) so the nav-state save effect is
      // never permanently disabled. Without this, a rejected initApp would leave
      // hydratedRef.current=false forever and the app would silently stop
      // persisting navigation state.
      try {
        const savedSort = safeLocalStorageGet(
          SORT_OPTION_KEY,
          "sort-option-read",
        );
        if (savedSort) {
          setSortOption(savedSort);
        }

        // B12-3 (extended to the whole ordered list): snapshot the stored
        // roots + legacy primary before the first await. The user can commit a
        // new root list while this init is in flight; any later signature
        // mismatch means THIS run's remote config is stale and the user's
        // choice wins (no adopt, no LS write, no wipe, no nav restore).
        const localStateAtStart = readLocalRootState(true);
        const localRoots = localStateAtStart.roots;
        // Local commit marker (epoch ms): when it is NEWER than the remote
        // updatedAt, the local list is a commit whose cloud save has not landed
        // yet (or failed) and must win over the stale remote config.
        const localUpdatedAt = readLocalVersionMarker();
        // Rebased after this run writes its own LS snapshot, so the guard only
        // reports changes made by the USER, not by our persist step.
        let expectedSignature = localStateAtStart.signature;
        const rootChangedByUser = () =>
          readLocalRootState(false).signature !== expectedSignature;

        // B12-5: set when this run's remote roots differ from the stored ones
        // — the cached listing is invalidated below and the persisted nav
        // snapshot (which points inside the OLD roots) must be discarded.
        let rootChanged = false;
        let roots: RootFolder[] = localRoots;
        // Set when the remote config is UNREADABLE and there is no usable local
        // copy. The app must not claim "you are new": leave the live state
        // untouched, flag the store and let the gate paint a retry surface.
        let configUnavailable = false;

        if (isLoggedIn && accessToken) {
          // Reconcile local vs remote roots (driveInit/rootReconciliation):
          // select authoritative list -> verify every root -> decide fallback.
          // The helper never throws for cancellation; every path is an outcome
          // so the hook alone decides whether to write state.
          const outcome = await reconcileRemoteRoots({
            signal: controller.signal,
            localRoots,
            localUpdatedAt,
            isReInit,
            isCancelled,
            rootChangedByUser,
          });
          if (outcome.kind === "cancelled") return;
          if (outcome.kind === "user-changed") {
            setConfigError(null);
            return;
          }
          if (outcome.kind === "keep-previous") {
            setConfigError(null);
            return;
          }
          if (outcome.kind === "config-unavailable") {
            configUnavailable = true;
          } else if (outcome.kind === "config-failed") {
            setConfigError(null);
            roots = [];
          } else {
            setConfigError(null);
            roots = outcome.roots;
            rootChanged = outcome.rootChanged;
          }
        } else {
          // Logged out: a stale config error must never survive the session.
          setConfigError(null);
        }

        if (isCancelled()) return;
        if (configUnavailable) {
          // Deliberately no appRootFolder/rootFolders write here: a null root
          // would read as "first run" and a non-empty root list must survive
          // the outage. The `finally` below still marks the session hydrated so
          // the gate can render the recoverable error surface.
          setConfigError("unavailable");
          return;
        }

        if (roots.length > 0) {
          const primaryRoot = roots[0];
          if (primaryRoot === undefined) {
            setAppRootFolder(null);
            setRootFolders([]);
            return;
          }
          const primaryId = primaryRoot.id;
          const isMulti = roots.length > 1;
          setRootFolders(roots);
          setAppRootFolder(primaryId);

          // Single place that writes the three nav fields, in the original
          // order (id -> name -> history). `history: undefined` means "leave
          // the live trail alone" (fallback keeps it; callers clear it).
          const applyNavTarget = (target: NavTarget) => {
            setCurrentFolderId(target.currentFolderId);
            setCurrentFolderName(target.currentFolderName);
            if (target.history !== undefined) {
              setFolderHistory(target.history);
            }
          };

          const fallbackToRoot = () => {
            applyNavTarget(buildFallbackNavTarget(primaryId, isMulti));
          };

          // B12-5: the configured roots changed in this run — the cached
          // listing was just invalidated and the persisted nav snapshot points
          // inside the OLD roots (out of the new scope). Land on the new root
          // instead of resuming a stale folder.
          if (rootChanged) {
            // The last in-loop check ran before the remote roots were applied;
            // a user commit landing since then must win over these writes.
            if (rootChangedByUser()) return;
            persistRootListLocally(primaryId, roots);
            expectedSignature = readLocalRootState(false).signature;
            // Invalidate the local listing only when the configured roots
            // actually changed (account-scoped — see driveInit/rootCache).
            await invalidateListingCacheForCurrentAccount();
            if (isCancelled()) return;
            if (rootChangedByUser()) return;
            fallbackToRoot();
            setFolderHistory([]);
            return;
          }
          if (isReInit) {
            // B12-1: token-rotation re-verify with unchanged roots — leave
            // the live nav state alone. Re-applying the persisted snapshot
            // would revert navigation made while the re-verify was in flight.
            return;
          }

          try {
            const state = await db.syncState.get(DB_NAV_STATE_KEY);
            if (isCancelled()) return;
            if (rootChangedByUser()) return;
            if (state && state.value) {
              const raw = state.value;
              if (typeof raw === "object" && "id" in raw) {
                const obj = raw as Record<string, unknown>;
                if (typeof obj.id === "string") {
                  applyNavTarget(
                    computeNavResume({
                      roots,
                      savedId: obj.id,
                      savedName:
                        typeof obj.name === "string" ? obj.name : MY_DRIVE_TAB,
                      savedHistory: parseNavHistory(obj.history),
                      savedRootId:
                        typeof obj.rootId === "string" ? obj.rootId : undefined,
                    }),
                  );
                } else {
                  fallbackToRoot();
                }
              } else {
                fallbackToRoot();
              }
            } else {
              const savedCurrentId = safeLocalStorageGet(
                CURRENT_FOLDER_ID_KEY,
                "current-folder-id-read",
              );
              const savedCurrentName = safeLocalStorageGet(
                CURRENT_FOLDER_NAME_KEY,
                "current-folder-name-read",
              );
              const savedHistoryStr = safeLocalStorageGet(
                FOLDER_HISTORY_KEY,
                "folder-history-read",
              );

              if (savedCurrentId && savedCurrentName && savedHistoryStr) {
                let history: { id: string; name: string }[];
                try {
                  history = parseNavHistory(JSON.parse(savedHistoryStr));
                } catch (e: unknown) {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `nav-state-parse: corrupt localStorage folder history, ${classifyError(e)}`,
                  });
                  history = [];
                }
                applyNavTarget(
                  computeNavResume({
                    roots,
                    savedId: savedCurrentId,
                    savedName: savedCurrentName,
                    savedHistory: history,
                  }),
                );
              } else {
                fallbackToRoot();
              }
            }
          } catch (e: unknown) {
            if (isCancelled()) return;
            void captureError({
              level: "warn",
              source: "useDrive",
              message: `nav-state-restore-failed: ${classifyError(e)}`,
            });
            fallbackToRoot();
          }
        } else {
          setAppRootFolder(null);
          setRootFolders([]);
        }
      } catch (e: unknown) {
        // Unexpected throw from initApp (e.g. an unhandled rejection). Fall back
        // to a safe state so the app is not stuck without an app root folder and
        // hydration still completes in the finally below.
        if (isCancelled()) return;
        void captureError({
          level: "error",
          source: "useDrive",
          message: `init-app-unexpected: ${classifyError(e)}`,
        });
        setAppRootFolder(null);
        setRootFolders([]);
      } finally {
        // Hydration safety: always flip to true unless the effect was cleaned up
        // (unmount / dependency change). If cancelled, a fresh effect run will
        // re-init with hydratedRef reset to false, so we must NOT hydrate here.
        // isHydrated rides the same guard: the cancelled run must not claim
        // the new session is settled before its own verify lands.
        if (!cancelled) {
          hydratedRef.current = true;
          setIsHydrated(true);
        }
      }
    };

    // Defensive net: initApp's own try/finally already guarantees hydration, but
    // this catch logs any rejection that escapes initApp instead of swallowing it.
    initApp().catch(
      (e: unknown) =>
        void captureError({
          level: "error",
          source: "useDrive",
          message: `init-app-failed: ${classifyError(e)}`,
        }),
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    // Stable `useRef` handle owned by useDrive, passed in as a prop. ESLint
    // cannot prove it is stable, and listing it cannot cause a re-run.
    hydratedRef,
    isLoggedIn,
    accessToken,
    // Retry nonce: App bumps it from the gate's "couldn't load" surface so the
    // retry re-runs THIS exact init path (no bespoke reload).
    reloadNonce,
    setSortOption,
    setAppRootFolder,
    setRootFolders,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setIsHydrated,
    setConfigError,
  ]);
};
